import type { ActionResultMessage } from '../../model/actionResult.js';
import type { TicketChangesState } from './snapshot.js';

/** The only webview requests accepted by the ticket changes panel. */
export type ChangesWebviewMessage =
  | { type: 'refresh' }
  | { type: 'open-diff'; changeId: string }
  | { type: 'open-file'; absolutePath: string }
  | { type: 'discard'; changeId: string }
  | { type: 'unstage'; changeId: string }
  | { type: 'copy-hash'; hash: string };

/**
 * A git object name and nothing else. The panel renders commit subjects the
 * ticket's repositories authored, so the webview is not a trusted speaker: what
 * it asks the host to put on the user's clipboard is narrowed to the one shape
 * a hash can have.
 */
const HASH = /^[0-9a-f]{7,40}$/;

/**
 * Messages the host may send to the ticket changes webview. `action-result` is
 * the single per-request terminal outcome (UI-R13). Today only `open-diff`
 * ever carries a `requestId` that reaches it: `refresh` keeps settling through
 * the existing `loading`/`state`/`error` broadcast — its terminal outcome IS
 * the next state push, which the async contract explicitly allows
 * (DESIGN-SYSTEM §5.1) — and `copy-hash` stays optimistic (UI-R15), so neither
 * one attaches a `requestId` from the webview.
 */
export type ChangesHostMessage =
  | { type: 'loading'; state: TicketChangesState | null }
  | { type: 'state'; state: TicketChangesState }
  | { type: 'error'; message: string }
  | ActionResultMessage;

/**
 * Host-side side-effects a changes panel message can trigger. A `void` return
 * acks the request as soon as it is accepted; a returned promise is awaited and
 * its settlement (resolve/reject) becomes the terminal `action-result`
 * (docs/ui/DESIGN-SYSTEM.md §5.3, UI-R13). This is a type widening from
 * `() => void` — every existing implementation still satisfies it.
 */
export interface ChangesActions {
  refresh(): void | Promise<void>;
  openDiff(changeId: string): void | Promise<void>;
  openFile(absolutePath: string): void | Promise<void>;
  discard(changeId: string): void | Promise<void>;
  unstage(changeId: string): void | Promise<void>;
  copyHash(hash: string): void | Promise<void>;
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
    case 'open-file':
      return typeof message.absolutePath === 'string' && message.absolutePath.length > 0
        ? { type: 'open-file', absolutePath: message.absolutePath }
        : null;
    case 'discard':
      return typeof message.changeId === 'string' && message.changeId.length > 0
        ? { type: 'discard', changeId: message.changeId }
        : null;
    case 'unstage':
      return typeof message.changeId === 'string' && message.changeId.length > 0
        ? { type: 'unstage', changeId: message.changeId }
        : null;
    case 'copy-hash':
      return typeof message.hash === 'string' && HASH.test(message.hash)
        ? { type: 'copy-hash', hash: message.hash }
        : null;
    default:
      return null;
  }
}

/**
 * Dispatch an ALREADY-PARSED message to its action, returning whatever the
 * action returns. The single dispatch seam (panel.ts) parses `raw` once, reads
 * its `requestId` off the raw shape (which this narrower deliberately never
 * sees), and wraps this call in `reportAction` so the caller can await a real
 * outcome and report exactly one terminal `action-result` (UI-R13).
 */
export function routeChangesAction(msg: ChangesWebviewMessage, actions: ChangesActions): void | Promise<void> {
  switch (msg.type) {
    case 'refresh':
      return actions.refresh();
    case 'open-diff':
      return actions.openDiff(msg.changeId);
    case 'open-file':
      return actions.openFile(msg.absolutePath);
    case 'discard':
      return actions.discard(msg.changeId);
    case 'unstage':
      return actions.unstage(msg.changeId);
    case 'copy-hash':
      return actions.copyHash(msg.hash);
  }
}
