/**
 * esbuild entry for the resources + servers React app → `src/ui/resources/app.webview.js`
 * (built by `scripts/build-webview-send.mjs`).
 *
 * Injected into `src/ui/resources/webview.html` in place of the
 * `KARST_RESOURCES_APP` marker. It is the document's ONLY `acquireVsCodeApi()`
 * caller (VS Code throws on a second call): it acquires the API once, builds the
 * typed sender over it, publishes the `vscode` + `karstSend` page globals the
 * app's `pageHostBridge` reads, and only then renders.
 *
 * The `data-karst-ready` flag `renderWebviewReady` waits on is set from an
 * effect in `App`, after the first commit.
 */
import { createRoot } from 'react-dom/client';
import { createSender } from '../webviewSend.js';
import type { ResourcesHostMessage } from '../messages.js';
import { App } from './App.js';

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();
const karstSend = createSender(vscode);

const buffered: ResourcesHostMessage[] = [];
let active: ((message: ResourcesHostMessage) => void) | null = null;

window.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as ResourcesHostMessage | undefined;
  if (data && typeof data === 'object' && typeof data.type === 'string') {
    if (active) active(data);
    else buffered.push(data);
  }
});

const globals = globalThis as unknown as {
  vscode: VsCodeApi;
  karstSend: typeof karstSend;
  __karstSubscribe?: (listener: (message: ResourcesHostMessage) => void) => () => void;
};
globals.vscode = vscode;
globals.karstSend = karstSend;
globals.__karstSubscribe = (listener) => {
  active = listener;
  while (buffered.length > 0) listener(buffered.shift()!);
  return () => {
    active = null;
  };
};

const container = document.getElementById('root');
if (!container) throw new Error('resources app: #root element is missing from the document');

createRoot(container).render(<App />);
