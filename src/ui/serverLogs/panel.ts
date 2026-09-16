import type { LogError } from '../../logging/logger.js';
import type { ServerLogsResult } from '../dashboard/serverLogsReader.js';
import {
  parseServerLogsMessage,
  routeServerLogsAction,
  type ServerLogsActions,
  type ServerLogsHostMessage,
} from './messages.js';

/** The subset of a webview panel used by the standalone server-logs manager. */
export interface ServerLogsPanel {
  reveal(): void;
  postMessage(message: ServerLogsHostMessage): void;
  onDidReceiveMessage(handler: (message: unknown) => void): void;
  onDidDispose(handler: () => void): void;
}

/** Factory for one ticket's standalone server-logs panel. */
export interface ServerLogsPanelHost {
  createPanel(title: string, ticketId: number): ServerLogsPanel;
}

/**
 * The read/stream half of `ServerLogsReader`, stated structurally so the
 * manager can take the real reader or a fast fake. The concrete class satisfies
 * it unchanged; this panel owns its own reader instance (Key Decision 6), never
 * the dashboard's — closing the dashboard leaves the standalone panel tailing.
 */
export interface ServerLogsSource {
  readLogs(servers: Array<{ service: string; logPath: string | null }>): ServerLogsResult;
  startPolling(
    servers: Array<{ service: string; logPath: string | null }>,
    ticketId: number,
    onOutput: (ticketId: number, service: string, text: string) => void,
  ): void;
  stopPolling(ticketId: number): void;
}

/**
 * One server-logs panel per ticket, so the dashboard and that ticket's logs are
 * visible side by side. A second `open` reveals the existing panel and creates
 * nothing; closing it stops that ticket's polling. A ticket with no services
 * still opens and shows the shared empty state.
 */
export class ServerLogsManager {
  private readonly sessions = new Map<number, ServerLogsPanel>();

  constructor(
    private readonly host: ServerLogsPanelHost,
    private readonly reader: ServerLogsSource,
    private readonly titleFor: (ticketId: number) => string,
    private readonly logServers: (
      ticketId: number,
    ) => Array<{ service: string; logPath: string | null }>,
    private readonly logError: LogError = (message, error) => console.error(message, error),
  ) {}

  open(ticketId: number): void {
    const existing = this.sessions.get(ticketId);
    if (existing) {
      existing.reveal();
      return;
    }

    const panel = this.host.createPanel(this.titleFor(ticketId), ticketId);
    this.sessions.set(ticketId, panel);

    panel.onDidReceiveMessage((raw) => {
      const msg = parseServerLogsMessage(raw);
      if (!msg) return;
      const actions: ServerLogsActions = {
        request: () => this.requestLogs(ticketId, panel),
        close: () => this.closeLogs(ticketId),
      };
      try {
        const result = routeServerLogsAction(msg, actions);
        if (result && typeof (result as PromiseLike<void>).then === 'function') {
          void (result as Promise<void>).catch((err: unknown) => {
            this.log('karst: server logs action failed', err);
          });
        }
      } catch (err) {
        this.log('karst: server logs action failed', err);
      }
    });
    panel.onDidDispose(() => {
      this.reader.stopPolling(ticketId);
      if (this.sessions.get(ticketId) === panel) this.sessions.delete(ticketId);
    });
  }

  isOpen(ticketId: number): boolean {
    return this.sessions.has(ticketId);
  }

  /** Extension shutdown: stop every ticket's timer and drop the sessions. */
  dispose(): void {
    for (const ticketId of [...this.sessions.keys()]) {
      this.reader.stopPolling(ticketId);
    }
    this.sessions.clear();
  }

  /**
   * Answer a `server-logs-request`: read every server log file through this
   * panel's own reader, post the initial snapshot, then poll for live chunks.
   * Always answers — with no services it posts an empty list, so the panel
   * opens on its empty state instead of refusing to open.
   */
  private requestLogs(ticketId: number, panel: ServerLogsPanel): void {
    const servers = this.logServers(ticketId);
    const result = this.reader.readLogs(servers);
    panel.postMessage({ type: 'server-logs', servers: result.servers });
    this.reader.startPolling(servers, ticketId, (id, service, text) => {
      const live = this.sessions.get(id);
      if (live) live.postMessage({ type: 'server-log-output', service, text });
    });
  }

  /** Answer a `server-logs-close`: stop this ticket's polling. */
  private closeLogs(ticketId: number): void {
    this.reader.stopPolling(ticketId);
  }

  private log(message: string, error: unknown): void {
    try {
      this.logError(message, error);
    } catch {
      // Terminal: the log channel itself failed; nothing left to report to.
    }
  }
}
