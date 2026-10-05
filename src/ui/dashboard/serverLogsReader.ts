import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { open, stat } from 'node:fs/promises';

export const SERVER_LOG_READ_CAP_BYTES = 2 * 1024 * 1024;

const TRUNCATION_MARKER = '\n[server log truncated]\n';

export interface ServerLogsResult {
  servers: Array<{
    service: string;
    logPath: string | null;
    content: string;
    truncated: boolean;
  }>;
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

/** Synchronously read at most `cap` bytes from the start — bounded, never the whole file. */
function readHeadSync(path: string, cap: number): { bytes: Buffer; size: number } {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const bytes = Buffer.alloc(Math.min(size, cap + 4));
    const n = readSync(fd, bytes, 0, bytes.length, 0);
    return { bytes: bytes.subarray(0, n), size };
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
  private lastSizes = new Map<string, number>();
  private timers = new Map<string, ReturnType<typeof setInterval>>();

  constructor(private readonly debug?: (msg: string) => void) {}

  readLogs(
    servers: Array<{ service: string; logPath: string | null }>,
  ): ServerLogsResult {
    return {
      servers: servers.map((s) => {
        if (!s.logPath) {
          this.debug?.(`[server-logs] ${s.service} has no logPath`);
          return { service: s.service, logPath: s.logPath, content: '', truncated: false };
        }
        try {
          const { bytes, size } = readHeadSync(s.logPath, SERVER_LOG_READ_CAP_BYTES);
          if (size <= SERVER_LOG_READ_CAP_BYTES) {
            return {
              service: s.service,
              logPath: s.logPath,
              content: bytes.toString('utf8'),
              truncated: false,
            };
          }
          const end = utf8SafeOffset(bytes, SERVER_LOG_READ_CAP_BYTES);
          return {
            service: s.service,
            logPath: s.logPath,
            content: `${bytes.subarray(0, end).toString('utf8')}${TRUNCATION_MARKER}`,
            truncated: true,
          };
        } catch {
          this.debug?.(`[server-logs] ${s.service} log unreadable: ${s.logPath}`);
          return { service: s.service, logPath: s.logPath, content: '', truncated: false };
        }
      }),
    };
  }

  startPolling(
    servers: Array<{ service: string; logPath: string | null }>,
    ticketId: number,
    onOutput: (ticketId: number, service: string, text: string) => void,
  ): void {
    this.stopPolling(ticketId);
    const tailed = servers.filter((s): s is { service: string; logPath: string } => !!s.logPath);
    let busy = true;
    const prime = Promise.all(
      tailed.map(async (s) => {
        const size = await stat(s.logPath).then((st) => st.size, () => 0);
        this.lastSizes.set(s.service, size);
      }),
    ).finally(() => {
      busy = false;
    });
    void prime;
    const key = String(ticketId);
    const timer = setInterval(() => {
      // A slow disk must never stack ticks: skip while the previous one runs.
      if (busy) return;
      busy = true;
      // A read still in flight when polling stops must not emit afterwards.
      const emit = (tid: number, service: string, text: string): void => {
        if (this.timers.get(key) === timer) onOutput(tid, service, text);
      };
      void Promise.all(tailed.map((s) => this.pollOne(s, ticketId, emit))).finally(() => {
        busy = false;
      });
    }, 1000);
    this.timers.set(key, timer);
  }

  /** One tick for one log: stat, then read only the bytes appended since the last tick. */
  private async pollOne(
    s: { service: string; logPath: string },
    ticketId: number,
    onOutput: (ticketId: number, service: string, text: string) => void,
  ): Promise<void> {
    try {
      const size = (await stat(s.logPath)).size;
      let prev = this.lastSizes.get(s.service) ?? 0;
      if (size === prev) return;
      if (size < prev) prev = 0; // truncated or rotated: start over from the head
      const end = Math.min(size, prev + SERVER_LOG_READ_CAP_BYTES);
      const bytes = await readRange(s.logPath, prev, end);
      const complete = utf8CompleteLength(bytes);
      this.lastSizes.set(s.service, prev + complete);
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
  }
}
