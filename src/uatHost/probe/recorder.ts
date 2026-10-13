export interface WebviewRecord {
  id: string;
  viewType: string;
  title: string;
  messageCount: number;
  lastMessage: unknown;
}
export interface NotificationRecord {
  level: 'info' | 'warning' | 'error';
  message: string;
}

const LOG_TAIL = 40;
const TS_PREFIX = /^\[?\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?\]?\s*/;

const WORKSPACE_HASH = /workspace-[0-9a-f]{8}/g;

/** Timestamps and the per-run workspace hash vary between runs; evidence must be stable. */
export function normalizeLogLine(line: string): string {
  return line.replace(TS_PREFIX, '').replace(WORKSPACE_HASH, 'workspace-<hash>');
}

/** Collects what the host showed. Pure state: the vscode binding feeds it. */
export class ProbeRecorder {
  private readonly webviews = new Map<string, WebviewRecord>();
  private readonly notes: NotificationRecord[] = [];
  private readonly log: string[] = [];

  notification(level: NotificationRecord['level'], message: string): void {
    this.notes.push({ level, message });
  }
  logLine(line: string): void {
    this.log.push(normalizeLogLine(line));
    if (this.log.length > LOG_TAIL) this.log.shift();
  }
  webviewOpened(id: string, viewType: string, title: string): void {
    this.webviews.set(id, { id, viewType, title, messageCount: 0, lastMessage: null });
  }
  webviewPosted(id: string, message: unknown): void {
    const w = this.webviews.get(id);
    if (w) this.webviews.set(id, { ...w, messageCount: w.messageCount + 1, lastMessage: message });
  }
  webviewClosed(id: string): void {
    this.webviews.delete(id);
  }
  view(): { webviews: WebviewRecord[]; notifications: NotificationRecord[]; logTail: string[] } {
    return {
      webviews: [...this.webviews.values()].sort((a, b) => a.id.localeCompare(b.id)),
      notifications: [...this.notes],
      logTail: [...this.log],
    };
  }
}
