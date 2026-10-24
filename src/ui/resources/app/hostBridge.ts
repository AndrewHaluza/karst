/**
 * The resources app's single seam onto the webview page.
 *
 * `main.tsx` is the bundle's only `acquireVsCodeApi()` caller (VS Code throws on
 * a second call) and publishes the page globals `vscode` and `karstSend`; the
 * app READS those instead of acquiring again, so every outbound message still
 * goes through the one typed sender. The seam is an interface so a component
 * test can drive the app against an injected double.
 */
import { createSender, type ResourcesSender, type WebviewApi } from '../webviewSend.js';
import type { PanelTab, ResourcesHostMessage } from '../messages.js';

/** What the webview keeps across a reload. */
export interface PersistedResourcesState {
  readonly tab: PanelTab;
}

export interface ResourcesHostBridge {
  readonly send: ResourcesSender;
  getState(): PersistedResourcesState | undefined;
  setState(state: PersistedResourcesState): void;
  /** Subscribe to host pushes; returns the unsubscribe function. */
  subscribe(listener: (message: ResourcesHostMessage) => void): () => void;
}

export interface PageVsCodeApi extends WebviewApi {
  getState(): unknown;
  setState(state: unknown): void;
}

export interface PageGlobals {
  readonly vscode?: PageVsCodeApi;
  readonly karstSend?: ResourcesSender;
  readonly __karstSubscribe?: (listener: (message: ResourcesHostMessage) => void) => () => void;
}

export function pageHostBridge(scope: PageGlobals = globalThis as PageGlobals): ResourcesHostBridge {
  const api = scope.vscode;
  if (!api) {
    throw new Error('resources app: window.vscode is missing — main.tsx must run before any UI');
  }
  const send = scope.karstSend ?? createSender(api);
  return {
    send,
    getState: () => {
      const raw = api.getState() as { tab?: unknown } | null | undefined;
      return raw?.tab === 'servers' || raw?.tab === 'resources' ? { tab: raw.tab } : undefined;
    },
    setState: (state) => api.setState(state),
    subscribe: (listener) => {
      const unsub = scope.__karstSubscribe ? scope.__karstSubscribe(listener) : () => {};
      send.requestState();
      return unsub;
    },
  };
}
