import { readFileSync } from 'node:fs';

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
          const bytes = readFileSync(s.logPath);
          if (bytes.length <= SERVER_LOG_READ_CAP_BYTES) {
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
    for (const s of servers) {
      if (!s.logPath) continue;
      try {
        this.lastSizes.set(s.service, readFileSync(s.logPath).length);
      } catch {
        this.lastSizes.set(s.service, 0);
      }
    }
    const key = String(ticketId);
    const timer = setInterval(() => {
      for (const s of servers) {
        if (!s.logPath) continue;
        try {
          const bytes = readFileSync(s.logPath);
          const byteLen = bytes.length;
          const prev = this.lastSizes.get(s.service) ?? 0;
          if (byteLen > prev) {
            const start = utf8SafeOffset(bytes, prev);
            this.lastSizes.set(s.service, byteLen);
            onOutput(ticketId, s.service, bytes.subarray(start).toString('utf8'));
          } else if (byteLen < prev) {
            this.lastSizes.set(s.service, 0);
            onOutput(ticketId, s.service, bytes.toString('utf8'));
          }
        } catch {
          this.debug?.(`[server-logs] poll read failed: ${s.service}`);
        }
      }
    }, 1000);
    this.timers.set(key, timer);
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
