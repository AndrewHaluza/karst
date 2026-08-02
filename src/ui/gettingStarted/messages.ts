import type { ActionResultMessage } from '../../model/actionResult.js';
import type { GettingStartedState } from './state.js';

/**
 * Getting Started webview ↔ host message protocol. The webview is a trust boundary:
 * `parseGettingStartedMessage` validates every discriminant before a host action runs
 * (which may touch the filesystem or run a command). All messages are bare tags
 * (no payloads), so validation is a discriminant whitelist. Mirrors
 * ticketForm/messages.ts.
 */

export type GettingStartedMessage =
  | { type: 'create-manifest' }
  | { type: 'recheck-deps' }
  | { type: 'open-settings' }
  | { type: 'create-ticket' }
  | { type: 'report-issue' }
  | { type: 'dismiss' }
  | { type: 'request-state' };

/**
 * The old bare `{type:'error', message}` channel is gone: every action now
 * reports through the single `action-result` seam (UI-R13), which is what
 * lets the webview surface a failure as a toast instead of the page's own
 * unlabelled `#error` div.
 */
export type GettingStartedHostMessage = { type: 'state'; state: GettingStartedState } | ActionResultMessage;

/**
 * Host-side side-effects the Getting Started page can trigger. A `void` return acks
 * the request as soon as it is accepted; a returned promise is awaited and
 * its settlement (resolve/reject) becomes the terminal `action-result`
 * (docs/ui/DESIGN-SYSTEM.md §5.3, UI-R13). This is a type widening from
 * `() => void` — every existing implementation still satisfies it.
 */
export interface GettingStartedActions {
  createManifest: () => void | Promise<void>;
  recheckDeps: () => void | Promise<void>;
  openSettings: () => void | Promise<void>;
  createTicket: () => void | Promise<void>;
  /** Hand off to the existing `karst.reportIssue` flow (§ issue reporting). */
  reportIssue: () => void | Promise<void>;
  dismiss: () => void | Promise<void>;
  requestState: () => void | Promise<void>;
}

const KNOWN: ReadonlySet<GettingStartedMessage['type']> = new Set([
  'create-manifest',
  'recheck-deps',
  'open-settings',
  'create-ticket',
  'report-issue',
  'dismiss',
  'request-state',
]);

export function parseGettingStartedMessage(raw: unknown): GettingStartedMessage | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const type = (raw as Record<string, unknown>).type;
  if (typeof type !== 'string' || !KNOWN.has(type as GettingStartedMessage['type'])) return null;
  return { type: type as GettingStartedMessage['type'] };
}

/**
 * Dispatch an ALREADY-PARSED message to its action, returning whatever the
 * action returns. The single dispatch seam (panel.ts) parses `raw` once,
 * reads its `requestId` off the raw shape (which this narrower deliberately
 * never sees), and wraps this call in `reportAction` so the caller can await
 * a real outcome and report exactly one terminal `action-result` (UI-R13).
 */
export function routeGettingStartedAction(msg: GettingStartedMessage, actions: GettingStartedActions): void | Promise<void> {
  switch (msg.type) {
    case 'create-manifest':
      return actions.createManifest();
    case 'recheck-deps':
      return actions.recheckDeps();
    case 'open-settings':
      return actions.openSettings();
    case 'create-ticket':
      return actions.createTicket();
    case 'report-issue':
      return actions.reportIssue();
    case 'dismiss':
      return actions.dismiss();
    case 'request-state':
      return actions.requestState();
  }
}
