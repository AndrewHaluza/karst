import type { TicketChangesState } from './snapshot.js';

/** The only webview requests accepted by the ticket changes panel. */
export type ChangesWebviewMessage =
  | { type: 'refresh' }
  | { type: 'open-diff'; changeId: string }
  | { type: 'copy-hash'; hash: string };

/**
 * A git object name and nothing else. The panel renders commit subjects the
 * ticket's repositories authored, so the webview is not a trusted speaker: what
 * it asks the host to put on the user's clipboard is narrowed to the one shape
 * a hash can have.
 */
const HASH = /^[0-9a-f]{7,40}$/;

/** Messages the host may send to the ticket changes webview. */
export type ChangesHostMessage =
  | { type: 'loading'; state: TicketChangesState | null }
  | { type: 'state'; state: TicketChangesState }
  | { type: 'error'; message: string };

export interface ChangesActions {
  refresh(): void;
  openDiff(changeId: string): void;
  copyHash(hash: string): void;
}

/** Narrow untrusted webview data to the changes protocol. */
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
    case 'copy-hash':
      return typeof message.hash === 'string' && HASH.test(message.hash)
        ? { type: 'copy-hash', hash: message.hash }
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
    case 'copy-hash':
      actions.copyHash(message.hash);
      return;
  }
}
