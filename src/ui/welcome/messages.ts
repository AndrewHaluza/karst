import type { ActionResultMessage } from '../../model/actionResult.js';
import type { WelcomeState } from './state.js';

/**
 * Welcome webview ↔ host message protocol. The webview is a trust boundary:
 * `parseWelcomeMessage` validates every discriminant before a host action runs
 * (which may touch the filesystem or run a command). All messages are bare tags
 * (no payloads), so validation is a discriminant whitelist. Mirrors
 * onboarding/messages.ts.
 */

export type WelcomeMessage =
  | { type: 'create-manifest' }
  | { type: 'recheck-deps' }
  | { type: 'open-settings' }
  | { type: 'create-ticket' }
  | { type: 'dismiss' }
  | { type: 'request-state' };

/**
 * The old bare `{type:'error', message}` channel is gone: every action now
 * reports through the single `action-result` seam (UI-R13), which is what
 * lets the webview surface a failure as a toast instead of the page's own
 * unlabelled `#error` div.
 */
export type WelcomeHostMessage = { type: 'state'; state: WelcomeState } | ActionResultMessage;

/**
 * Host-side side-effects the welcome page can trigger. A `void` return acks
 * the request as soon as it is accepted; a returned promise is awaited and
 * its settlement (resolve/reject) becomes the terminal `action-result`
 * (docs/ui/DESIGN-SYSTEM.md §5.3, UI-R13). This is a type widening from
 * `() => void` — every existing implementation still satisfies it.
 */
export interface WelcomeActions {
  createManifest: () => void | Promise<void>;
  recheckDeps: () => void | Promise<void>;
  openSettings: () => void | Promise<void>;
  createTicket: () => void | Promise<void>;
  dismiss: () => void | Promise<void>;
  requestState: () => void | Promise<void>;
}

const KNOWN: ReadonlySet<WelcomeMessage['type']> = new Set([
  'create-manifest',
  'recheck-deps',
  'open-settings',
  'create-ticket',
  'dismiss',
  'request-state',
]);

export function parseWelcomeMessage(raw: unknown): WelcomeMessage | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const type = (raw as Record<string, unknown>).type;
  if (typeof type !== 'string' || !KNOWN.has(type as WelcomeMessage['type'])) return null;
  return { type: type as WelcomeMessage['type'] };
}

/**
 * Dispatch an ALREADY-PARSED message to its action, returning whatever the
 * action returns. The single dispatch seam (panel.ts) parses `raw` once,
 * reads its `requestId` off the raw shape (which this narrower deliberately
 * never sees), and wraps this call in `reportAction` so the caller can await
 * a real outcome and report exactly one terminal `action-result` (UI-R13).
 */
export function routeWelcomeAction(msg: WelcomeMessage, actions: WelcomeActions): void | Promise<void> {
  switch (msg.type) {
    case 'create-manifest':
      return actions.createManifest();
    case 'recheck-deps':
      return actions.recheckDeps();
    case 'open-settings':
      return actions.openSettings();
    case 'create-ticket':
      return actions.createTicket();
    case 'dismiss':
      return actions.dismiss();
    case 'request-state':
      return actions.requestState();
  }
}
