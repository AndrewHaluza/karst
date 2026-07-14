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

export type WelcomeHostMessage =
  | { type: 'state'; state: WelcomeState }
  | { type: 'error'; message: string };

/** Host-side side-effects the welcome page can trigger. */
export interface WelcomeActions {
  createManifest: () => void;
  recheckDeps: () => void;
  openSettings: () => void;
  createTicket: () => void;
  dismiss: () => void;
  requestState: () => void;
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

export function routeWelcomeAction(raw: unknown, actions: WelcomeActions): void {
  const msg = parseWelcomeMessage(raw);
  if (!msg) return;
  switch (msg.type) {
    case 'create-manifest':
      actions.createManifest();
      return;
    case 'recheck-deps':
      actions.recheckDeps();
      return;
    case 'open-settings':
      actions.openSettings();
      return;
    case 'create-ticket':
      actions.createTicket();
      return;
    case 'dismiss':
      actions.dismiss();
      return;
    case 'request-state':
      actions.requestState();
      return;
  }
}
