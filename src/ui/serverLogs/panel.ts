import type { LogError } from '../../logging/logger.js';
import { logMatchText, logNewLinesText } from '../../model/notifyText.js';
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
 * One log source row. `status` is the row's RS-17 word, carried to the surface
 * so a tab label names the server's state (LG-14).
 */
export interface ServerLogsSourceRow {
  service: string;
  logPath: string | null;
  status?: string;
}

/**
 * A log panel's scope: one ticket, or the project's shared services (RS-13). The
 * shared scope has no ticket id — the view opens from a shared row's Logs verb.
 */
export type ServerLogsScope = number | 'shared';

/**
 * `tickets.id` are positive, so 0 is free as the reader's key for the shared
 * scope. The reader keys its timers and offsets by a number; this constant is
 * the one place the shared scope is spelled as one.
 */
export const SHARED_LOGS_SCOPE_ID = 0;

/** The shared panel's title when the host injects none. */
export const SHARED_LOGS_TITLE = 'Server Logs — Shared services';

/**
 * One server-logs panel per ticket, so the dashboard and that ticket's logs are
 * visible side by side. A second `open` reveals the existing panel and creates
 * nothing; closing it stops that ticket's polling. A ticket with no services
 * still opens and shows the shared empty state.
 */
/** Optional host seams the standalone panel needs beyond scheduling. */
export interface ServerLogsManagerOptions {
  /**
   * Write the view's Copy text to the clipboard. Absent → Copy is a no-op;
   * the extension host binds `vscode.env.clipboard.writeText` here.
   */
  writeClipboard?: (text: string) => Promise<void>;
  /** The ticket key the view title names ("Server logs · FEAT-12"). */
  ticketKeyFor?: (ticketId: number) => string | null;
  /** The shared services' log rows; absent → the shared scope opens on its empty state. */
  sharedLogServers?: () => ServerLogsSourceRow[];
  /** The shared panel's title; absent → `SHARED_LOGS_TITLE`. */
  sharedTitle?: string;
}

export class ServerLogsManager {
  private readonly sessions = new Map<ServerLogsScope, ServerLogsPanel>();

  constructor(
    private readonly host: ServerLogsPanelHost,
    private readonly reader: ServerLogsSource,
    private readonly titleFor: (ticketId: number) => string,
    private readonly logServers: (ticketId: number) => ServerLogsSourceRow[],
    private readonly logError: LogError = (message, error) => console.error(message, error),
    private readonly options: ServerLogsManagerOptions = {},
  ) {}

  /**
   * Open (or reveal) the panel for a scope: one ticket, or the project's shared
   * services (no ticket id, RS-13).
   */
  open(scope: ServerLogsScope): void {
    this.openScope(scope);
  }

  /** The shared services' combined log: no ticket id, one panel per window (RS-13). */
  openShared(): void {
    this.openScope('shared');
  }

  isOpen(ticketId: number): boolean {
    return this.sessions.has(ticketId);
  }

  /** Extension shutdown: stop every scope's timer and drop the sessions. */
  dispose(): void {
    for (const scope of [...this.sessions.keys()]) {
      this.reader.stopPolling(this.readerId(scope));
    }
    this.sessions.clear();
  }

  private openScope(scope: ServerLogsScope): void {
    const existing = this.sessions.get(scope);
    if (existing) {
      existing.reveal();
      return;
    }

    const readerId = this.readerId(scope);
    const panel = this.host.createPanel(this.titleOf(scope), readerId);
    this.sessions.set(scope, panel);

    panel.onDidReceiveMessage((raw) => {
      const msg = parseServerLogsMessage(raw);
      if (!msg) return;
      const actions: ServerLogsActions = {
        request: () => this.requestLogs(scope, panel),
        close: () => this.closeLogs(scope),
        matchCount: (count, seq, current) =>
          panel.postMessage({ type: 'server-logs-match-text', seq, text: logMatchText(count, current) }),
        newCount: (count, seq) =>
          panel.postMessage({ type: 'server-logs-new-text', seq, text: logNewLinesText(count) }),
        copy: (text) => this.writeClipboard(text),
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
      this.reader.stopPolling(readerId);
      if (this.sessions.get(scope) === panel) this.sessions.delete(scope);
    });
  }

  private readerId(scope: ServerLogsScope): number {
    return scope === 'shared' ? SHARED_LOGS_SCOPE_ID : scope;
  }

  private titleOf(scope: ServerLogsScope): string {
    return scope === 'shared' ? (this.options.sharedTitle ?? SHARED_LOGS_TITLE) : this.titleFor(scope);
  }

  private rowsOf(scope: ServerLogsScope): ServerLogsSourceRow[] {
    if (scope === 'shared') return this.options.sharedLogServers?.() ?? [];
    return this.logServers(scope);
  }

  /**
   * Answer a `server-logs-request`: read every server log file through this
   * panel's own reader, post the initial snapshot, then poll for live chunks.
   * Always answers — with no services it posts an empty list, so the panel
   * opens on its empty state instead of refusing to open. Each entry carries
   * its row's RS-17 word for the tab label (LG-14).
   */
  private requestLogs(scope: ServerLogsScope, panel: ServerLogsPanel): void {
    const servers = this.rowsOf(scope);
    const result = this.reader.readLogs(servers);
    const words = new Map(
      servers.flatMap((row) => (row.status ? ([[row.service, row.status]] as const) : [])),
    );
    const entries = result.servers.map((entry) => {
      const status = words.get(entry.service);
      return status ? { ...entry, status } : entry;
    });
    const key = scope === 'shared' ? null : (this.options.ticketKeyFor?.(scope) ?? null);
    panel.postMessage({ type: 'server-logs', servers: entries, ...(key ? { key } : {}) });
    this.reader.startPolling(servers, this.readerId(scope), (id, service, text) => {
      const live = this.sessions.get(scope);
      if (live && id === this.readerId(scope)) live.postMessage({ type: 'server-log-output', service, text });
    });
  }

  /** Answer a `server-logs-close`: stop this scope's polling. */
  private closeLogs(scope: ServerLogsScope): void {
    this.reader.stopPolling(this.readerId(scope));
  }

  /** Write the view's shown text to the clipboard; a host without a seam is a no-op. */
  private writeClipboard(text: string): void {
    try {
      void this.options.writeClipboard?.(text)?.catch(() => undefined);
    } catch {
      // Clipboard access denied: the Copy control is harmless.
    }
  }

  private log(message: string, error: unknown): void {
    try {
      this.logError(message, error);
    } catch {
      // Terminal: the log channel itself failed; nothing left to report to.
    }
  }
}
