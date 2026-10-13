import { lstat, open, readFile, rename, writeFile } from 'node:fs/promises';
import { MAX_BRIDGE_LINE_BYTES } from './bridgeVerifier.js';

const MAX_READ_BYTES = 1024 * 1024;
const NEWLINE = 0x0a;

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
  readonly onLine: (line: string) => void;
  readonly debug?: (message: string) => void;
}

async function loadOffset(stateFile: string): Promise<number> {
  try {
    const parsed: unknown = JSON.parse(await readFile(stateFile, 'utf8'));
    const offset = (parsed as { offset?: unknown }).offset;
    return typeof offset === 'number' && Number.isInteger(offset) && offset >= 0 ? offset : 0;
  } catch {
    return 0;
  }
}

async function saveOffset(stateFile: string, offset: number): Promise<void> {
  const tmp = `${stateFile}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify({ offset }));
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
  let carry: Buffer = Buffer.alloc(0);
  let timer: NodeJS.Timeout | undefined;
  let stopped = true;
  let discarding = false;
  let inFlight: Promise<void> = Promise.resolve();

  async function readNew(): Promise<void> {
    if (offset === undefined) offset = await loadOffset(opts.stateFile);
    let stat;
    try {
      stat = await lstat(opts.file);
    } catch {
      return;
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      log(`refusing ${opts.file}: symlink or not a regular file`);
      return;
    }
    if (stat.size < offset) {
      log(`events file truncated (${stat.size} < ${offset}); restarting from 0`);
      offset = 0;
      carry = Buffer.alloc(0);
    }
    if (stat.size === offset) return;
    const length = Math.min(stat.size - offset, MAX_READ_BYTES);
    const handle = await open(opts.file, 'r');
    let chunk: Buffer;
    try {
      chunk = Buffer.alloc(length);
      const { bytesRead } = await handle.read(chunk, 0, length, offset);
      chunk = chunk.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
    offset += chunk.length;
    let buf: Buffer = Buffer.concat([carry, chunk]);
    if (discarding) {
      // Still inside an oversized line: nothing up to its newline is trusted.
      const nl = buf.indexOf(NEWLINE);
      if (nl === -1) {
        carry = Buffer.alloc(0);
        await saveOffset(opts.stateFile, offset);
        return;
      }
      buf = buf.subarray(nl + 1);
      discarding = false;
    }
    for (let nl = buf.indexOf(NEWLINE); nl !== -1; nl = buf.indexOf(NEWLINE)) {
      const line = buf.subarray(0, nl).toString('utf8');
      buf = buf.subarray(nl + 1);
      if (line.length === 0) continue;
      try {
        opts.onLine(line);
      } catch (err) {
        log(`onLine threw: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (buf.length > MAX_BRIDGE_LINE_BYTES) {
      log(`dropped an oversized unterminated line (${buf.length} bytes)`);
      discarding = true;
      carry = Buffer.alloc(0);
      await saveOffset(opts.stateFile, offset);
      return;
    }
    carry = buf;
    await saveOffset(opts.stateFile, offset - carry.length);
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
