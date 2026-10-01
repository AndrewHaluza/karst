/**
 * Inject the pre-built, type-checked dashboard webview message-sender bundle
 * into the dashboard document.
 *
 * The dashboard's `webviewSend.entry.ts` is bundled by esbuild to a sibling
 * `webviewSend.webview.js` (`scripts/build-webview-send.mjs`; folded into
 * `scripts/build-extension.mjs`). The bundle is read as plain text through
 * `RUNTIME_ASSETS_ROOT` — the same mechanism `agentPicker.ts` /
 * `serverLogsView.ts` use — and swapped into the view's marker, so the runtime
 * text lands verbatim in the document and `injectCsp` can nonce it.
 *
 * Settings no longer passes through here: at phase 4 (NDL-126 §8.4) the
 * settings sender was folded into the React app bundle (`app/main.tsx` imports
 * `webviewSend.ts` directly and is the document's single `acquireVsCodeApi()`
 * caller), so the `KARST_WEBVIEW_SEND_SETTINGS` marker and its bundle are
 * retired for settings. The settings chain injects the app bundle instead.
 *
 * A missing bundle must THROW: a silent fallback would ship a webview whose
 * `karstSend` is undefined and every control a no-op. There is deliberately no
 * `try`/`catch`, no `.cache/` and no `import.meta.url` arithmetic here.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RUNTIME_ASSETS_ROOT } from '../runtimeAssetsRoot.js';

/** Marker in the dashboard webview's inline script. */
export const WEBVIEW_SEND_DASHBOARD_MARKER = '/*KARST_WEBVIEW_SEND_DASHBOARD*/';

/** The dashboard sender bundle text, read from the runtime assets root. */
export function dashboardWebviewSendJs(): string {
  return readFileSync(join(RUNTIME_ASSETS_ROOT, 'ui/dashboard/webviewSend.webview.js'), 'utf8').trim();
}

/** Replace the dashboard sender marker with its bundle; throws if absent. */
export function injectWebviewSend(html: string): string {
  if (!html.includes(WEBVIEW_SEND_DASHBOARD_MARKER)) {
    throw new Error(`webview send marker missing for dashboard: ${WEBVIEW_SEND_DASHBOARD_MARKER}`);
  }
  return html.replace(WEBVIEW_SEND_DASHBOARD_MARKER, () => dashboardWebviewSendJs());
}
