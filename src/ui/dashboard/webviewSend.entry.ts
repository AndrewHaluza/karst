/**
 * The dashboard webview's ONE bundle entry.
 *
 * This is the only module in the dashboard webview that calls
 * `acquireVsCodeApi()`. VS Code throws on the second call in a document, so
 * the release-once rule is structural: the HTML no longer carries its own
 * `const vscode = acquireVsCodeApi()`; instead this IIFE runs first, acquires
 * the API once, builds the typed sender (`createSender`) over it, and exposes
 * both as page globals (`vscode`, `karstSend`) for the plain-JS HTML to use.
 *
 * esbuild bundles this file to `ui/dashboard/webviewSend.webview.js`
 * (`scripts/build-webview-send.mjs`), which is injected in place of the
 * `KARST_WEBVIEW_SEND_DASHBOARD` marker before the document is served.
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

// `globalThis` is `window` in a real webview and the VM sandbox object under
// the unit harness — assigning here makes the bare `vscode` / `karstSend`
// lookups in the HTML resolve in both.
const globals = globalThis as unknown as {
  vscode: VsCodeApi;
  karstSend: typeof karstSend;
};
globals.vscode = vscode;
globals.karstSend = karstSend;
