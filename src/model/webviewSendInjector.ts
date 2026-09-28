/**
 * Inject the pre-built, type-checked webview message-sender bundles into the
 * dashboard and settings documents.
 *
 * Each webview's `webviewSend.entry.ts` is bundled by esbuild to a sibling
 * `webviewSend.webview.js` (`scripts/build-webview-send.mjs`; folded into
 * `scripts/build-extension.mjs`). The bundle is read as plain text through
 * `RUNTIME_ASSETS_ROOT` — the same mechanism `agentPicker.ts` /
 * `serverLogsView.ts` use — and swapped into the view's marker, so the runtime
 * text lands verbatim in the document and `injectCsp` can nonce it.
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

/** Marker in the settings webview's inline script. */
export const WEBVIEW_SEND_SETTINGS_MARKER = '/*KARST_WEBVIEW_SEND_SETTINGS*/';

/** The dashboard sender bundle text, read from the runtime assets root. */
export function dashboardWebviewSendJs(): string {
  return readFileSync(join(RUNTIME_ASSETS_ROOT, 'ui/dashboard/webviewSend.webview.js'), 'utf8').trim();
}

/** The settings sender bundle text, read from the runtime assets root. */
export function settingsWebviewSendJs(): string {
  return readFileSync(join(RUNTIME_ASSETS_ROOT, 'ui/settings/webviewSend.webview.js'), 'utf8').trim();
}

/** Replace the view's sender marker with its bundle; throws if the bundle is absent. */
export function injectWebviewSend(html: string, view: 'dashboard' | 'settings'): string {
  const marker =
    view === 'dashboard' ? WEBVIEW_SEND_DASHBOARD_MARKER : WEBVIEW_SEND_SETTINGS_MARKER;
  if (!html.includes(marker)) {
    throw new Error(`webview send marker missing for ${view}: ${marker}`);
  }
  return html.replace(marker, () =>
    view === 'dashboard' ? dashboardWebviewSendJs() : settingsWebviewSendJs(),
  );
}
