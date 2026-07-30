import type { LogError } from '../../logging/logger.js';
import type { DiffTarget } from './git.js';
import {
  routeChangesMessage,
  type ChangesHostMessage,
} from './messages.js';
import type { TicketChangesSnapshot } from './snapshot.js';

/** The subset of a webview panel used by the ticket changes manager. */
export interface ChangesPanel {
  reveal(): void;
  postMessage(message: ChangesHostMessage): void;
  onDidReceiveMessage(handler: (message: unknown) => void): void;
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
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
    private readonly load: (ticketId: number) => Promise<TicketChangesSnapshot>,
    private readonly openDiff: (target: DiffTarget) => Promise<void>,
    private readonly warn: (message: string) => void,
    private readonly logError: LogError = (message, error) => console.error(message, error),
  ) {}

  open(ticketId: number): void {
    const existing = this.sessions.get(ticketId);
    if (existing) {
      existing.panel.reveal();
      this.refresh(ticketId, existing);
      return;
    }

    const panel = this.host.createPanel(this.titleFor(ticketId), ticketId);
    const session: PanelSession = { panel, requestId: 0, snapshot: null, disposed: false };
    this.sessions.set(ticketId, session);

    panel.onDidReceiveMessage((raw) => {
      if (!this.isLive(ticketId, session)) return;
      try {
        routeChangesMessage(raw, {
          refresh: () => this.refresh(ticketId, session),
          openDiff: (changeId) => this.openTarget(ticketId, session, changeId),
        });
      } catch (error) {
        this.logError('karst: ticket changes action failed', error);
      }
    });
    panel.onDidDispose(() => {
      session.disposed = true;
      if (this.sessions.get(ticketId) === session) this.sessions.delete(ticketId);
    });

    this.refresh(ticketId, session);
  }

  isOpen(ticketId: number): boolean {
    return this.sessions.has(ticketId);
  }

  private refresh(ticketId: number, session: PanelSession): void {
    if (!this.isLive(ticketId, session)) return;
    const requestId = ++session.requestId;
    session.panel.postMessage({ type: 'loading', state: session.snapshot?.state ?? null });

    void this.load(ticketId).then(
      (snapshot) => {
        if (!this.isCurrent(ticketId, session, requestId)) return;
        session.snapshot = snapshot;
        session.panel.postMessage({ type: 'state', state: snapshot.state });
      },
      (error) => {
        if (!this.isCurrent(ticketId, session, requestId)) return;
        const message = errorMessage(error);
        this.logError('karst: loading ticket changes failed', error);
        session.panel.postMessage({ type: 'error', message });
      },
    );
  }

  private openTarget(ticketId: number, session: PanelSession, changeId: string): void {
    if (!this.isLive(ticketId, session)) return;
    const target = session.snapshot?.targets.get(changeId);
    if (!target) {
      this.warn('That change is stale. Refreshing ticket changes…');
      this.refresh(ticketId, session);
      return;
    }

    void this.openDiff(target).catch((error: unknown) => {
      this.logError('karst: opening ticket change failed', error);
      this.warn(errorMessage(error));
    });
  }

  private isLive(ticketId: number, session: PanelSession): boolean {
    return !session.disposed && this.sessions.get(ticketId) === session;
  }

  private isCurrent(ticketId: number, session: PanelSession, requestId: number): boolean {
    return this.isLive(ticketId, session) && session.requestId === requestId;
  }
}
