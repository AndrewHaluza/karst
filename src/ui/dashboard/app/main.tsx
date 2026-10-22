/**
 * esbuild entry for the dashboard React app → `src/ui/dashboard/app.webview.js`
 * (built by `scripts/build-webview-send.mjs`).
 *
 * Injected into `src/ui/dashboard/webview.html` in place of the `KARST_DASHBOARD_APP` marker.
 * Reuses or acquires the VS Code webview API, exposes typed message sender,
 * and mounts `<App />` into `#root`.
 */
import { createRoot } from 'react-dom/client';
import { createSender } from '../webviewSend.js';
import type { HostMessage } from '../messages.js';
import { App } from './App.js';

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

const existingGlobals = globalThis as unknown as {
  vscode?: VsCodeApi;
  karstSend?: ReturnType<typeof createSender>;
  __karstSubscribe?: (listener: (message: HostMessage) => void) => () => void;
};

const vscode: VsCodeApi = existingGlobals.vscode ?? {
  postMessage: () => {},
  getState: () => null,
  setState: () => {},
};

const karstSend = existingGlobals.karstSend ?? createSender(vscode);

const bufferedMessages: HostMessage[] = [];
const subscribers = new Set<(message: HostMessage) => void>();

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('message', (event: MessageEvent) => {
    const data = event.data as HostMessage | undefined;
    if (data && typeof data === 'object' && typeof data.type === 'string') {
      if (subscribers.size > 0) {
        for (const sub of subscribers) {
          sub(data);
        }
      } else {
        bufferedMessages.push(data);
      }
    }
  });
}

const globals = globalThis as unknown as {
  vscode: VsCodeApi;
  karstSend: typeof karstSend;
  __karstSubscribe?: (listener: (message: HostMessage) => void) => () => void;
};
globals.vscode = vscode;
globals.karstSend = karstSend;
globals.__karstSubscribe = (listener) => {
  subscribers.add(listener);
  for (const msg of bufferedMessages) {
    listener(msg);
  }
  return () => {
    subscribers.delete(listener);
  };
};

const container = typeof document !== 'undefined' ? document.getElementById('root') : null;

if (!container) {
  throw new Error('dashboard app: #root element is missing from the document');
}

createRoot(container).render(<App />);
