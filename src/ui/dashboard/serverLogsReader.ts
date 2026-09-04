import { readFileSync } from 'node:fs';

export const SERVER_LOG_READ_CAP_BYTES = 2 * 1024 * 1024;

export interface ServerLogsResult {
  servers: Array<{
    service: string;
    logPath: string | null;
    content: string;
    truncated: boolean;
  }>;
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
          const content = readFileSync(s.logPath, 'utf8');
          const byteLen = Buffer.byteLength(content, 'utf8');
          if (byteLen <= SERVER_LOG_READ_CAP_BYTES) {
            return { service: s.service, logPath: s.logPath, content, truncated: false };
          }
          return {
            service: s.service,
            logPath: s.logPath,
            content: `${content.slice(0, SERVER_LOG_READ_CAP_BYTES)}\n[server log truncated]\n`,
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
        const stat = readFileSync(s.logPath, 'utf8');
        this.lastSizes.set(s.service, Buffer.byteLength(stat, 'utf8'));
      } catch {
        this.lastSizes.set(s.service, 0);
      }
    }
    const key = String(ticketId);
    const timer = setInterval(() => {
      for (const s of servers) {
        if (!s.logPath) continue;
        try {
          const content = readFileSync(s.logPath, 'utf8');
          const byteLen = Buffer.byteLength(content, 'utf8');
          const prev = this.lastSizes.get(s.service) ?? 0;
          if (byteLen > prev) {
            const chunk = content.slice(prev);
            this.lastSizes.set(s.service, byteLen);
            onOutput(ticketId, s.service, chunk);
          } else if (byteLen < prev) {
            this.lastSizes.set(s.service, 0);
            onOutput(ticketId, s.service, content);
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
