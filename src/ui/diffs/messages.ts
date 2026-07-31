import type { TicketChangesState } from './snapshot.js';

/** The only webview requests accepted by the ticket changes panel. */
export type ChangesWebviewMessage =
  | { type: 'refresh' }
  | { type: 'open-diff'; changeId: string };

/** Messages the host may send to the ticket changes webview. */
export type ChangesHostMessage =
  | { type: 'loading'; state: TicketChangesState | null }
  | { type: 'state'; state: TicketChangesState }
  | { type: 'error'; message: string };

export interface ChangesActions {
  refresh(): void;
  openDiff(changeId: string): void;
}

/** Narrow untrusted webview data to the two-message changes protocol. */
export function parseChangesMessage(raw: unknown): ChangesWebviewMessage | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const message = raw as Record<string, unknown>;

  switch (message.type) {
    case 'refresh':
      return { type: 'refresh' };
    case 'open-diff':
      return typeof message.changeId === 'string' && message.changeId.length > 0
        ? { type: 'open-diff', changeId: message.changeId }
        : null;
    default:
      return null;
  }
}

/** Parse then dispatch a changes message; malformed input deliberately does nothing. */
export function routeChangesMessage(raw: unknown, actions: ChangesActions): void {
  const message = parseChangesMessage(raw);
  if (!message) return;

  switch (message.type) {
    case 'refresh':
      actions.refresh();
      return;
    case 'open-diff':
      actions.openDiff(message.changeId);
      return;
  }
}
