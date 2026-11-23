import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { open, stat } from 'node:fs/promises';

export const SERVER_LOG_READ_CAP_BYTES = 2 * 1024 * 1024;

/**
 * Why an entry has no content. `ok` carries the newest output; the other three
 * say which of the three pre-content situations this is, so the panel never
 * shows the same blank box for "no service", "not written yet" and "cannot read"
 * (LG-8).
 */
export type ServerLogState = 'ok' | 'empty' | 'no-path' | 'unreadable';

export const TRUNCATION_PREFIX = '[Earlier output not shown: ';

export interface ServerLogEntryResult {
  service: string;
  logPath: string | null;
  content: string;
  truncated: boolean;
  state: ServerLogState;
  /** The finished explanation for a non-`ok` state; empty for `ok`. */
  message: string;
}

export interface ServerLogsResult {
  servers: ServerLogEntryResult[];
}

/** `14.2 MB` — the skipped part of a truncated log, one decimal. */
export function formatBytesLabel(bytes: number): string {
  const mib = bytes / (1024 * 1024);
  return `${mib.toFixed(1)} MB`;
}

/**
 * The largest byte offset <= `limit` that does not split a UTF-8 character, so
 * a byte slice taken there decodes without a replacement character. A byte in
 * the continuation range at the cut means the character owning it began
 * earlier, so step back to its lead byte. Logs are stored/compared in BYTES
 * (see `lastSizes`), never character indices — mixing the two re-emits or skips
 * a segment whenever the log carries any multi-byte character.
 */
function utf8SafeOffset(buf: Buffer, limit: number): number {
  let end = Math.min(limit, buf.length);
  while (end > 0 && end < buf.length && (buf[end]! & 0xc0) === 0x80) end--;
  return end;
}

/**
 * Length of `buf` minus a trailing incomplete UTF-8 sequence, so a tail read
 * that ends mid-character holds those bytes back for the next tick instead of
 * emitting a replacement character.
 */
function utf8CompleteLength(buf: Buffer): number {
  let lead = buf.length - 1;
  while (lead >= 0 && buf.length - lead < 4 && (buf[lead]! & 0xc0) === 0x80) lead--;
  if (lead < 0) return buf.length;
  const b = buf[lead]!;
  const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
  return buf.length - lead < need ? lead : buf.length;
}

/**
 * Synchronously read at most `cap` bytes from the END — bounded, never the whole
 * file. The head of a large log is the least useful part: the newest output is
 * what a user opens the panel for (LG-1).
 *
 * The read starts at `size - cap`, which can land inside a line (and inside a
 * multi-byte character). The caller drops the partial leading line, and the
 * `+4` bytes absorb a character split by the safe-offset step-back. `skipped`
 * is the number of bytes before the first kept byte, so the marker can name it.
 */
function readTailSync(path: string, cap: number): { bytes: Buffer; size: number; skipped: number } {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - cap);
    const bytes = Buffer.alloc(Math.min(size - start, cap + 4));
    const n = readSync(fd, bytes, 0, bytes.length, start);
    const buf = bytes.subarray(0, n);
    if (start === 0) return { bytes: buf, size, skipped: 0 };
    // Skip the partial first line: everything up to and including its newline.
    // A log with no newline at all keeps its bytes; only a split leading
    // character is dropped, so the tail decodes without U+FFFD.
    const newline = buf.indexOf(0x0a);
    let kept = newline === -1 ? 0 : utf8SafeOffset(buf, newline + 1);
    while (kept < buf.length && (buf[kept]! & 0xc0) === 0x80) kept++;
    return { bytes: buf.subarray(kept), size, skipped: start + kept };
  } finally {
    closeSync(fd);
  }
}

/** Asynchronously read bytes [start, end) — the poll tick must not block the host. */
async function readRange(path: string, start: number, end: number): Promise<Buffer> {
  const handle = await open(path, 'r');
  try {
    const buf = Buffer.alloc(end - start);
    const { bytesRead } = await handle.read(buf, 0, buf.length, start);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

export class ServerLogsReader {
  /** Offsets are per TICKET (`ticketId → service → byte`); see `startPolling`. */
  private readonly lastSizes = new Map<number, Map<string, number>>();
  private timers = new Map<string, ReturnType<typeof setInterval>>();

  constructor(
    private readonly debug?: (msg: string) => void,
    private readonly pollIntervalMs = 1000,
  ) {}

  readLogs(
    servers: Array<{ service: string; logPath: string | null }>,
  ): ServerLogsResult {
    return {
      servers: servers.map((s) => {
        if (!s.logPath) {
          this.debug?.(`[server-logs] ${s.service} has no logPath`);
          return {
            service: s.service,
            logPath: s.logPath,
            content: '',
            truncated: false,
            state: 'no-path' as const,
            message: `${s.service} has no log file.`,
          };
        }
        try {
          const { bytes, size, skipped } = readTailSync(s.logPath, SERVER_LOG_READ_CAP_BYTES);
          if (size === 0) {
            return {
              service: s.service,
              logPath: s.logPath,
              content: '',
              truncated: false,
              state: 'empty' as const,
              message: `${s.service} has not written to its log yet.`,
            };
          }
          const tail = bytes.toString('utf8');
          if (skipped === 0) {
            return {
              service: s.service,
              logPath: s.logPath,
              content: tail,
              truncated: false,
              state: 'ok' as const,
              message: '',
            };
          }
          return {
            service: s.service,
            logPath: s.logPath,
            content: `${TRUNCATION_PREFIX}${formatBytesLabel(skipped)}]\n${tail}`,
            truncated: true,
            state: 'ok' as const,
            message: '',
          };
        } catch (err) {
          // ENOENT is the ordinary "no output yet"; anything else is unreadable.
          const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
          this.debug?.(`[server-logs] ${s.service} log ${missing ? 'missing' : 'unreadable'}: ${s.logPath}`);
          return {
            service: s.service,
            logPath: s.logPath,
            content: '',
            truncated: false,
            state: missing ? ('empty' as const) : ('unreadable' as const),
            message: missing
              ? `${s.service} has not written to its log yet.`
              : `Karst cannot read ${s.logPath}.`,
          };
        }
      }),
    };
  }

  /**
   * Start tailing. The returned promise resolves once the initial sizes are
   * recorded (the baseline every later tick diffs against); ticks are skipped
   * until then. Callers that do not need to await the baseline may ignore it.
   */
  startPolling(
    servers: Array<{ service: string; logPath: string | null }>,
    ticketId: number,
    onOutput: (ticketId: number, service: string, text: string) => void,
  ): Promise<void> {
    this.stopPolling(ticketId);
    const tailed = servers.filter((s): s is { service: string; logPath: string } => !!s.logPath);
    // ONE offset map per TICKET, not per service: two dashboards can consume the
    // same SHARED baseline service, and a shared counter would let whichever
    // panel polls first swallow the delta the other never sees.
    const sizes = new Map<string, number>();
    this.lastSizes.set(ticketId, sizes);
    let busy = true;
    const prime = Promise.all(
      tailed.map(async (s) => {
        const size = await stat(s.logPath).then((st) => st.size, () => 0);
        sizes.set(s.service, size);
      }),
    ).finally(() => {
      busy = false;
    }).then(() => undefined);
    const key = String(ticketId);
    const timer = setInterval(() => {
      // A slow disk must never stack ticks: skip while the previous one runs.
      if (busy) return;
      busy = true;
      // A read still in flight when polling stops must not emit afterwards.
      const emit = (tid: number, service: string, text: string): void => {
        if (this.timers.get(key) === timer) onOutput(tid, service, text);
      };
      void Promise.all(tailed.map((s) => this.pollOne(s, ticketId, sizes, emit))).finally(() => {
        busy = false;
      });
    }, this.pollIntervalMs);
    this.timers.set(key, timer);
    return prime;
  }

  /** One tick for one log: stat, then read only the bytes appended since the last tick. */
  private async pollOne(
    s: { service: string; logPath: string },
    ticketId: number,
    sizes: Map<string, number>,
    onOutput: (ticketId: number, service: string, text: string) => void,
  ): Promise<void> {
    try {
      const size = (await stat(s.logPath)).size;
      let prev = sizes.get(s.service) ?? 0;
      if (size === prev) return;
      if (size < prev) prev = 0; // truncated or rotated: start over from the head
      const end = Math.min(size, prev + SERVER_LOG_READ_CAP_BYTES);
      const bytes = await readRange(s.logPath, prev, end);
      const complete = utf8CompleteLength(bytes);
      sizes.set(s.service, prev + complete);
      if (complete > 0) onOutput(ticketId, s.service, bytes.subarray(0, complete).toString('utf8'));
    } catch {
      this.debug?.(`[server-logs] poll read failed: ${s.service}`);
    }
  }

  stopPolling(ticketId: number): void {
    const key = String(ticketId);
    const timer = this.timers.get(key);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(key);
    }
    // The offsets belong to this panel's tail; a reopened view primes afresh.
    this.lastSizes.delete(ticketId);
  }
}
