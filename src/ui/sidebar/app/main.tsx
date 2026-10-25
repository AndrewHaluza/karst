/**
 * esbuild entry for the sidebar React app → `src/ui/sidebar/app.webview.js`
 * (built by `scripts/build-webview-send.mjs`).
 *
 * Injected into `src/ui/sidebar/webview.html` in place of the
 * `KARST_SIDEBAR_APP` marker. It is the document's ONLY `acquireVsCodeApi()`
 * caller (VS Code throws on a second call): it acquires the API once, publishes
 * the `vscode` page global the app's `pageHostBridge` reads, buffers host pushes
 * that arrive before the app subscribes, and only then renders.
 *
 * The `data-karst-ready` flag `renderWebviewReady` waits on is set from an
 * effect in `App`, after the first commit.
 */
import { createRoot } from 'react-dom/client';
import type { SidebarHostMessage } from '../messages.js';
import type { PageVsCodeApi } from './hostBridge.js';
import { App } from './App.js';

declare function acquireVsCodeApi(): PageVsCodeApi;

const vscode = acquireVsCodeApi();

const buffered: SidebarHostMessage[] = [];
let active: ((message: SidebarHostMessage) => void) | null = null;

window.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as SidebarHostMessage | undefined;
  if (data && typeof data === 'object' && typeof data.type === 'string') {
    if (active) active(data);
    else buffered.push(data);
  }
});

const globals = globalThis as unknown as {
  vscode: PageVsCodeApi;
  __karstSubscribe?: (listener: (message: SidebarHostMessage) => void) => () => void;
};
globals.vscode = vscode;
globals.__karstSubscribe = (listener) => {
  active = listener;
  while (buffered.length > 0) listener(buffered.shift()!);
  return () => {
    active = null;
  };
};

const container = document.getElementById('root');
if (!container) throw new Error('sidebar app: #root element is missing from the document');

createRoot(container).render(<App />);
