/**
 * esbuild entry for the settings React app → `src/ui/settings/app.webview.js`
 * (built by `scripts/build-webview-send.mjs`, NDL-126 §1).
 *
 * Since phase 4 this bundle is the settings webview's ONE script: it is
 * injected by `injectSettingsApp` in place of the app marker
 * (KARST_SETTINGS_APP) in `webview.html` (the vanilla view retired with the
 * switch-over).
 *
 * It is also the ONLY caller of `acquireVsCodeApi()` in the document (VS Code
 * throws on a second call) — the job `webviewSend.entry.ts` did before phase 4
 * folded the sender bundle into this one. It acquires the API once, builds the
 * typed sender over it (`webviewSend.ts`, checked against the host message
 * union by `tsc`), publishes the `vscode` + `karstSend` page globals the app's
 * `pageHostBridge` reads, and only then renders.
 *
 * React 19's `createRoot().render()` takes no completion callback, so the
 * `data-karst-ready` flag that `renderWebviewReady` waits on (NDL-126 §4) is set
 * from an effect in `App`, after the first commit.
 */
import { createRoot } from 'react-dom/client';
import { createSender } from '../webviewSend.js';
import type { SettingsHostMessage } from '../messages.js';
import { App } from './App.js';

/** The subset of the VS Code webview API the page uses. */
interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();
const karstSend = createSender(vscode);

const bufferedMessages: SettingsHostMessage[] = [];
let activeListener: ((message: SettingsHostMessage) => void) | null = null;

window.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as SettingsHostMessage | undefined;
  if (data && typeof data === 'object' && typeof data.type === 'string') {
    if (activeListener) {
      activeListener(data);
    } else {
      bufferedMessages.push(data);
    }
  }
});

const globals = globalThis as unknown as {
  vscode: VsCodeApi;
  karstSend: typeof karstSend;
  __karstSubscribe?: (listener: (message: SettingsHostMessage) => void) => () => void;
};
globals.vscode = vscode;
globals.karstSend = karstSend;
globals.__karstSubscribe = (listener) => {
  activeListener = listener;
  while (bufferedMessages.length > 0) {
    listener(bufferedMessages.shift()!);
  }
  return () => {
    activeListener = null;
  };
};

const container = document.getElementById('root');

if (!container) {
  throw new Error('settings app: #root element is missing from the document');
}

createRoot(container).render(<App />);
karstSend.requestState();
