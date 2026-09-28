/**
 * The settings webview's ONE bundle entry.
 *
 * The only caller of `acquireVsCodeApi()` in the document (VS Code throws on a
 * second call). esbuild bundles this file to
 * `ui/settings/webviewSend.webview.js` (`scripts/build-webview-send.mjs`),
 * which replaces the `KARST_WEBVIEW_SEND_SETTINGS` marker before the document
 * is served. It acquires the API once, builds the typed sender over it, and
 * exposes `vscode` + `karstSend` as page globals for the plain-JS HTML.
 */

import { createSender } from './webviewSend.js';

/** The subset of the VS Code webview API the page uses. */
interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();
const karstSend = createSender(vscode);

const globals = globalThis as unknown as {
  vscode: VsCodeApi;
  karstSend: typeof karstSend;
};
globals.vscode = vscode;
globals.karstSend = karstSend;
