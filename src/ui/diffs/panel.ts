import type { LogError } from '../../logging/logger.js';
import { readRequestId, reportAction } from '../../model/actionResult.js';
import { diffViewColumn } from './diffColumn.js';
import { StaleDiffTargetError, type DiffTarget } from './git.js';
import {
  parseChangesMessage,
  routeChangesAction,
  type ChangesActions,
  type ChangesHostMessage,
  type ChangesWebviewMessage,
} from './messages.js';
import type { TicketChangesSnapshot } from './snapshot.js';

/** The subset of a webview panel used by the ticket changes manager. */
export interface ChangesPanel {
  reveal(): void;
  /** The editor group the panel is in, or `undefined` while it is hidden. */
  viewColumn(): number | undefined;
  postMessage(message: ChangesHostMessage): void;
  onDidReceiveMessage(handler: (message: unknown) => void): void;
  /**
   * The panel gained or lost activation (real: `onDidChangeViewState`, reading
   * `e.webviewPanel.active`). `active` is true only when the user is actually
   * on this panel.
   */
  onDidChangeViewState(handler: (active: boolean) => void): void;
  onDidDispose(handler: () => void): void;
}

/** Factory for one ticket changes panel. */
export interface ChangesPanelHost {
  createPanel(title: string, ticketId: number): ChangesPanel;
}

interface PanelSession {
  panel: ChangesPanel;
  requestId: number;
  snapshot: TicketChangesSnapshot | null;
  disposed: boolean;
  controller: AbortController | null;
  refreshQueued: boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function abortError(): Error {
  const error = new Error('Ticket changes refresh was aborted');
  error.name = 'AbortError';
  return error;
}

/**
 * One changes panel per ticket. A new load replaces the current snapshot only
 * if it is still the newest request for the live panel session.
 */
export class TicketChangesManager {
  private readonly sessions = new Map<number, PanelSession>();

  constructor(
    private readonly host: ChangesPanelHost,
    private readonly titleFor: (ticketId: number) => string,
    private readonly load: (
      ticketId: number,
      signal: AbortSignal,
    ) => Promise<TicketChangesSnapshot>,
    private readonly openDiff: (
      target: DiffTarget,
      viewColumn: number | undefined,
    ) => Promise<void>,
    private readonly warn: (message: string) => void,
    private readonly logError: LogError = (message, error) => console.error(message, error),
    private readonly writeClipboard: (text: string) => void = () => {},
    /**
     * Reports raw panel activation — including LOSING it — so the host can
     * track which ticket's view is the window's ACTIVE view (sidebar
     * highlight). Absent → no report.
     */
    private readonly onViewActivated?: (ticketId: number, active: boolean) => void,
  ) {}

  open(ticketId: number): void {
    const existing = this.sessions.get(ticketId);
    if (existing) {
      existing.panel.reveal();
      // Focus-taking, like the create path below: `onDidChangeViewState` fires
      // on changes, so the reveal that focused the panel must be reported here.
      this.onViewActivated?.(ticketId, true);
      this.refresh(ticketId, existing);
      return;
    }

    const panel = this.host.createPanel(this.titleFor(ticketId), ticketId);
    const session: PanelSession = {
      panel,
      requestId: 0,
      snapshot: null,
      disposed: false,
      controller: null,
      refreshQueued: false,
    };
    this.sessions.set(ticketId, session);

    panel.onDidReceiveMessage((raw) => {
      if (!this.isLive(ticketId, session)) return;
      // The requestId is read off the RAW message, before parsing narrows it
      // away (parseChangesMessage deliberately drops every field it does not
      // model). `reportAction` never rejects, so the message pump is safe by
      // construction; an unparsed message posts nothing (UI-R13). `refresh`
      // and `copy-hash` never carry a requestId from the webview, so `send`
      // inside `reportAction` is a no-op for them — their outcomes still
      // reach the user through the existing broadcast / optimistic paths.
      const requestId = readRequestId(raw);
      const msg = parseChangesMessage(raw);
      if (!msg) return;
      const actions: ChangesActions = {
        refresh: () => this.refresh(ticketId, session),
        openDiff: (changeId) => this.openTarget(ticketId, session, changeId),
        copyHash: (hash) => this.copyHash(hash),
      };
      void reportAction(requestId, (m) => panel.postMessage(m), () => this.runAction(msg, actions));
    });
    panel.onDidChangeViewState((active) => this.onViewActivated?.(ticketId, active));
    panel.onDidDispose(() => {
      // The ACTIVE view can be closed while focused; the dispose is the only
      // signal that the focus is gone, so report it exactly like a deactivation.
      this.onViewActivated?.(ticketId, false);
      session.disposed = true;
      session.refreshQueued = false;
      session.snapshot = null;
      session.controller?.abort();
      session.controller = null;
      if (this.sessions.get(ticketId) === session) this.sessions.delete(ticketId);
    });

    this.refresh(ticketId, session);
    // Creation focuses the panel, and `onDidChangeViewState` fires on changes,
    // not on the initial activation — report it so the sidebar highlights it.
    this.onViewActivated?.(ticketId, true);
  }

  isOpen(ticketId: number): boolean {
    return this.sessions.has(ticketId);
  }

  /**
   * Extension shutdown. Every other async owner in the host is drained at
   * deactivate; without this one an in-flight load settles AFTER the store is
   * closed and the `.finally` re-entry runs the injected loader against a dead
   * SQLite connection. Marking each session disposed is what stops that
   * re-entry — aborting alone would not, because the queued refresh is
   * dispatched from the settlement handler, not from the signal.
   */
  dispose(): void {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    for (const session of sessions) {
      session.disposed = true;
      session.refreshQueued = false;
      session.snapshot = null;
      session.controller?.abort();
      session.controller = null;
    }
  }

  private refresh(ticketId: number, session: PanelSession): void {
    if (!this.isLive(ticketId, session)) return;
    if (session.controller) {
      session.refreshQueued = true;
      session.controller.abort();
      return;
    }

    const requestId = ++session.requestId;
    const controller = new AbortController();
    session.controller = controller;
    session.panel.postMessage({ type: 'loading', state: session.snapshot?.state ?? null });

    void Promise.resolve().then(() => {
      if (controller.signal.aborted) throw abortError();
      return this.load(ticketId, controller.signal);
    }).then(
      (snapshot) => {
        if (controller.signal.aborted) return;
        if (!this.isCurrent(ticketId, session, requestId)) return;
        session.snapshot = snapshot;
        session.panel.postMessage({ type: 'state', state: snapshot.state });
      },
      (error) => {
        if (controller.signal.aborted) return;
        if (!this.isCurrent(ticketId, session, requestId)) return;
        const message = errorMessage(error);
        this.logError('karst: loading ticket changes failed', error);
        session.panel.postMessage({ type: 'error', message });
      },
    ).finally(() => {
      if (session.controller !== controller) return;
      session.controller = null;
      if (!this.isLive(ticketId, session) || !session.refreshQueued) return;
      session.refreshQueued = false;
      this.refresh(ticketId, session);
    }).catch((error: unknown) => {
      // `ChangesPanel` is an injected interface: `postMessage` on a torn-down
      // webview can throw, from either settlement handler or from the queued
      // refresh re-entered above. Without this the voided tail would surface as
      // an unhandled rejection in the extension host.
      this.report('karst: ticket changes refresh failed', error);
    });
  }

  /**
   * Unlike `refresh`, this one now RETURNS its outcome instead of swallowing
   * it: opening a diff used to report failure only through the native VS Code
   * toast (`warn`) with nothing said inside the webview itself. All the same
   * side effects still happen in the same order — the native toast is not
   * replaced, only joined by the in-webview `action-result` the dispatch seam
   * derives from this promise (UI-R13). The one case that stays silent to the
   * dispatch seam is a stale changeId / StaleDiffTargetError: those already
   * self-heal (warn + refresh), so they resolve rather than reject.
   */
  private async openTarget(ticketId: number, session: PanelSession, changeId: string): Promise<void> {
    if (!this.isLive(ticketId, session)) return;
    const target = session.snapshot?.targets.get(changeId);
    if (!target) {
      this.warn('That change is stale. Refreshing ticket changes…');
      this.refresh(ticketId, session);
      return;
    }

    // Resolved per click from the LIVE panel: the user may have dragged the
    // panel into another group since it opened, and the diff belongs beside
    // where the panel is now.
    const column = diffViewColumn(session.panel.viewColumn());
    try {
      await this.openDiff(target, column);
    } catch (error) {
      if (!this.isLive(ticketId, session)) return;
      if (error instanceof StaleDiffTargetError) {
        this.warn(error.message);
        this.refresh(ticketId, session);
        return;
      }
      this.logError('karst: opening ticket change failed', error);
      this.warn(errorMessage(error));
      throw error;
    }
  }

  /**
   * The webview already confirmed the copy optimistically, so a failure here
   * would otherwise be invisible: it is reported, never swallowed. The hash was
   * validated as a git object name before it reached this point.
   */
  private copyHash(hash: string): void {
    try {
      this.writeClipboard(hash);
    } catch (error) {
      this.logError('karst: copying a commit hash failed', error);
      this.warn(`Could not copy ${hash} to the clipboard.`);
    }
  }

  /**
   * Dispatch one parsed message, logging (but still surfacing) any failure so
   * `reportAction` can turn it into a real `action-result` (UI-R13). Mirrors
   * `welcome`'s `runAction`: this is the ONE place that logs a dispatch
   * failure generically, on top of whatever action-specific log line the
   * action itself already wrote (e.g. `openTarget`'s 'opening ticket change
   * failed') — the two are deliberately not merged into one message, because
   * the action-specific one is the useful one to grep for and this one is a
   * structural safety net shared by every action.
   */
  private runAction(msg: ChangesWebviewMessage, actions: ChangesActions): void | Promise<void> {
    try {
      const result = routeChangesAction(msg, actions);
      if (result && typeof (result as PromiseLike<void>).then === 'function') {
        return (result as Promise<void>).catch((err: unknown) => {
          this.logError('karst: ticket changes action failed', err);
          throw err;
        });
      }
      return result;
    } catch (err) {
      this.logError('karst: ticket changes action failed', err);
      throw err;
    }
  }

  /**
   * The last handler on a voided chain. A throw from the log channel itself has
   * nowhere left to go, so it is contained here rather than escaping as an
   * unhandled rejection — every other failure is reported before reaching this.
   */
  private report(message: string, error: unknown): void {
    try {
      this.logError(message, error);
    } catch {
      // Intentionally terminal.
    }
  }

  private isLive(ticketId: number, session: PanelSession): boolean {
    return !session.disposed && this.sessions.get(ticketId) === session;
  }

  private isCurrent(ticketId: number, session: PanelSession, requestId: number): boolean {
    return this.isLive(ticketId, session) && session.requestId === requestId;
  }
}
