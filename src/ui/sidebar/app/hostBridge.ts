/**
 * The sidebar app's single seam onto the webview page.
 *
 * `main.tsx` is the bundle's only `acquireVsCodeApi()` caller (VS Code throws on
 * a second call) and publishes the page globals `vscode` and `__karstSubscribe`;
 * the app READS those instead of acquiring again. The seam is an interface so a
 * test can drive the app against an injected double.
 */
import type { SidebarHostMessage, SidebarWebviewMessage } from '../messages.js';
import type { SidebarState } from '../state.js';

/** Every posting control stamps a `requestId` the host echoes in `action-result`. */
export type OutboundMessage = SidebarWebviewMessage & { requestId?: string };

export interface SidebarHostBridge {
  post(message: OutboundMessage): void;
  getState(): SidebarState | undefined;
  setState(state: SidebarState): void;
  /** Subscribe to host pushes; returns the unsubscribe function. */
  subscribe(listener: (message: SidebarHostMessage) => void): () => void;
}

export interface PageVsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

export interface PageGlobals {
  readonly vscode?: PageVsCodeApi;
  readonly __karstSubscribe?: (listener: (message: SidebarHostMessage) => void) => () => void;
}

export function pageHostBridge(scope: PageGlobals = globalThis as PageGlobals): SidebarHostBridge {
  const api = scope.vscode;
  if (!api) throw new Error('sidebar app: window.vscode is missing — main.tsx must run before any UI');
  const post = (message: OutboundMessage): void => api.postMessage(message);
  return {
    post,
    getState: () => (api.getState() as SidebarState | null | undefined) ?? undefined,
    setState: (state) => api.setState(state),
    subscribe: (listener) => {
      const unsub = scope.__karstSubscribe ? scope.__karstSubscribe(listener) : () => {};
      post({ type: 'request-state' });
      return unsub;
    },
  };
}
