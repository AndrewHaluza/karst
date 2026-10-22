/**
 * The dashboard app's single seam onto the webview page (mirroring settings hostBridge.ts).
 *
 * Reads page globals `vscode` and `karstSend` (or builds sender from vscode),
 * provides typed outbound messaging (`send`), persisted state access (`getState`/`setState`),
 * and host message subscription (`subscribe`).
 */
import { createSender, type WebviewApi } from '../webviewSend.js';
import type { HostMessage } from '../messages.js';

export type DashboardSender = ReturnType<typeof createSender>;

export interface DashboardHostBridge {
  readonly send: DashboardSender;
  getState(): unknown;
  setState(state: unknown): void;
  subscribe(listener: (message: HostMessage) => void): () => void;
}

export interface PageVsCodeApi extends WebviewApi {
  getState(): unknown;
  setState(state: unknown): void;
}

export interface PageGlobals {
  readonly vscode?: PageVsCodeApi;
  readonly karstSend?: DashboardSender;
  readonly __karstSubscribe?: (listener: (message: HostMessage) => void) => () => void;
}

export function pageHostBridge(scope: PageGlobals = globalThis as PageGlobals): DashboardHostBridge {
  const api = scope.vscode;
  if (!api) {
    throw new Error('dashboard app: window.vscode is missing — webviewSend must run before dashboard app');
  }

  const send = scope.karstSend ?? createSender(api);
  const target = scope as unknown as EventTarget;

  return {
    send,
    getState: () => api.getState(),
    setState: (state) => api.setState(state),
    subscribe: (listener) => {
      let unsub: () => void;
      if (scope.__karstSubscribe) {
        unsub = scope.__karstSubscribe(listener);
      } else if (typeof target?.addEventListener === 'function') {
        const onMessage = (event: Event): void => {
          const data = (event as MessageEvent).data as HostMessage | undefined;
          if (data && typeof data === 'object' && typeof data.type === 'string') {
            listener(data);
          }
        };
        target.addEventListener('message', onMessage);
        unsub = () => target.removeEventListener?.('message', onMessage);
      } else {
        unsub = () => {};
      }
      return unsub;
    },
  };
}
