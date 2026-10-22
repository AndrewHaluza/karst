import { constants as fsConstants } from 'node:fs';
import { createHash } from 'node:crypto';
import { open, readFile, rename, writeFile, type FileHandle } from 'node:fs/promises';
import { MAX_BRIDGE_LINE_BYTES } from './bridgeVerifier.js';

const MAX_READ_BYTES = 1024 * 1024;
/** Lines handled per poll; the rest wait for the next tick, so a flood never starves the host. */
export const MAX_LINES_PER_POLL = 500;
const NEWLINE = 0x0a;
// O_NONBLOCK: a planted FIFO must not block open(); the isFile() check then refuses it.
const OPEN_FLAGS = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;

export interface BridgePoller {
  start(): void;
  stop(): Promise<void>;
  pollOnce(): Promise<void>;
}

export interface BridgePollerOptions {
  readonly file: string;
  /** Lives OUTSIDE the sandbox-mounted dir. */
  readonly stateFile: string;
  readonly intervalMs: number;
  /** May be async: a poll never saves the offset before the line's durability work settles. */
  readonly onLine: (line: string) => void | Promise<void>;
  readonly debug?: (message: string) => void;
}

/** How many leading bytes fingerprint the file: a rewritten file has a different head. */
const HEAD_BYTES = 64;

interface PollerState {
  readonly offset: number;
  /** sha1 of the first `min(HEAD_BYTES, offset)` bytes at save time; absent for an empty/legacy state. */
  readonly head?: string;
}

async function loadState(stateFile: string): Promise<PollerState> {
  try {
    const parsed = JSON.parse(await readFile(stateFile, 'utf8')) as { offset?: unknown; head?: unknown };
    const offset = parsed.offset;
    if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) return { offset: 0 };
    return { offset, ...(typeof parsed.head === 'string' ? { head: parsed.head } : {}) };
  } catch {
    return { offset: 0 };
  }
}

const hashOf = (bytes: Buffer): string => createHash('sha1').update(bytes).digest('hex');

/** Fingerprint of the first `min(HEAD_BYTES, upTo)` bytes of `handle`'s file, or undefined when it is shorter. */
async function headHash(handle: FileHandle, upTo: number): Promise<string | undefined> {
  const length = Math.min(HEAD_BYTES, upTo);
  if (length === 0) return undefined;
  const buf = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buf, 0, length, 0);
  return bytesRead === length ? hashOf(buf) : undefined;
}

async function saveState(stateFile: string, state: PollerState): Promise<void> {
  const tmp = `${stateFile}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(state));
  await rename(tmp, stateFile);
}

/**
 * Async tail of the per-ticket `events.ndjson` (Decision 1): setTimeout chain
 * (never overlapping), bounded reads, no spawnSync. The persisted offset is
 * the first UNCONSUMED byte, so a restart re-reads a half-written line.
 */
export function createBridgePoller(opts: BridgePollerOptions): BridgePoller {
  const log = (m: string): void => opts.debug?.(`[bridge] ${m}`);
  let offset: number | undefined;
  /** Head fingerprint of the saved offset (loaded at first poll, refreshed on every save). */
  let head: string | undefined;
  /** Bytes the fingerprint covers (`min(HEAD_BYTES, saved offset)`). */
  let headLen = 0;
  let carry: Buffer = Buffer.alloc(0);
  let timer: NodeJS.Timeout | undefined;
  let stopped = true;
  let discarding = false;
  let inFlight: Promise<void> = Promise.resolve();

  /**
   * Opens with O_NOFOLLOW so a symlink swapped in at any time is refused
   * (no lstat-then-open TOCTOU), then sizes and reads through the handle.
   * Returns undefined when there is nothing new or the file is refused.
   */
  /** Persist the first unconsumed byte plus the file's head fingerprint (read through a fresh no-follow handle). */
  async function persist(saved: number): Promise<void> {
    let fingerprint: string | undefined;
    try {
      const handle = await open(opts.file, OPEN_FLAGS);
      try {
        fingerprint = await headHash(handle, saved);
      } finally {
        await handle.close();
      }
    } catch {
      fingerprint = undefined;
    }
    head = fingerprint;
    headLen = Math.min(HEAD_BYTES, saved);
    await saveState(opts.stateFile, { offset: saved, ...(fingerprint ? { head: fingerprint } : {}) });
  }

  async function readChunk(): Promise<Buffer | undefined> {
    let handle: FileHandle;
    try {
      handle = await open(opts.file, OPEN_FLAGS);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') log(`refusing ${opts.file}: symlink or unreadable (${code ?? 'error'})`);
      return undefined;
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) {
        log(`refusing ${opts.file}: not a regular file`);
        return undefined;
      }
      if (stat.size < (offset ?? 0)) {
        log(`events file truncated (${stat.size} < ${offset}); restarting from 0`);
        offset = 0;
        head = undefined;
        carry = Buffer.alloc(0);
        discarding = false;
      } else if (head !== undefined && (await headHash(handle, headLen)) !== head) {
        // Same or larger size but different start: the file was rewritten. Rescan from 0; the sink skips
        // marker seqs the host already handled, so nothing replays and new lines are not hidden.
        log(`events file rewritten (head changed at offset ${offset}); restarting from 0`);
        offset = 0;
        head = undefined;
        carry = Buffer.alloc(0);
        discarding = false;
      }
      if (stat.size === offset) return undefined;
      const length = Math.min(stat.size - (offset ?? 0), MAX_READ_BYTES);
      const buf = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buf, 0, length, offset);
      return buf.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }

  async function readNew(): Promise<void> {
    if (offset === undefined) {
      const saved = await loadState(opts.stateFile);
      offset = saved.offset;
      head = saved.head;
      headLen = Math.min(HEAD_BYTES, saved.offset);
    }
    const chunk = await readChunk();
    if (chunk === undefined) return;
    offset += chunk.length;
    let buf: Buffer = Buffer.concat([carry, chunk]);
    if (discarding) {
      // Still inside an oversized line: nothing up to its newline is trusted.
      const nl = buf.indexOf(NEWLINE);
      if (nl === -1) {
        carry = Buffer.alloc(0);
        await persist(offset);
        return;
      }
      buf = buf.subarray(nl + 1);
      discarding = false;
    }
    let handled = 0;
    for (let nl = buf.indexOf(NEWLINE); nl !== -1; nl = buf.indexOf(NEWLINE)) {
      if (handled === MAX_LINES_PER_POLL) {
        // Leave the rest unconsumed: the next tick re-reads from here.
        offset -= buf.length;
        carry = Buffer.alloc(0);
        await persist(offset);
        return;
      }
      handled += 1;
      const line = buf.subarray(0, nl).toString('utf8');
      buf = buf.subarray(nl + 1);
      if (line.length === 0) continue;
      try {
        await opts.onLine(line);
      } catch (err) {
        log(`onLine threw: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (buf.length > MAX_BRIDGE_LINE_BYTES) {
      log(`dropped an oversized unterminated line (${buf.length} bytes)`);
      discarding = true;
      carry = Buffer.alloc(0);
      await persist(offset);
      return;
    }
    carry = buf;
    await persist(offset - carry.length);
  }

  const pollOnce = (): Promise<void> => {
    inFlight = inFlight.then(readNew).catch((err) => {
      log(`poll failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    return inFlight;
  };

  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      void pollOnce().then(schedule);
    }, opts.intervalMs);
  };

  return {
    start: () => {
      if (!stopped) return;
      stopped = false;
      schedule();
    },
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      await inFlight;
    },
    pollOnce,
  };
}
