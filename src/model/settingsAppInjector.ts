/**
 * Inject the pre-built settings React app bundle into the settings document
 * (NDL-126 §1).
 *
 * The app is bundled by the same esbuild pipeline as the message senders
 * (`scripts/build-webview-send.mjs`) and read as plain text through
 * `RUNTIME_ASSETS_ROOT`, so the runtime text lands verbatim in the document and
 * `injectCsp` can nonce it.
 *
 * Phase 1 activates this injector in the settings chain, but the shipped
 * `webview.html` does not carry the marker yet — so it is a no-op and the
 * vanilla script stays live (NDL-126 §8.1). Phase 4 adds the marker and the
 * bundle takes over. When the marker IS present the bundle must exist: a
 * missing bundle THROWS, same as the sender injector, because a silent fallback
 * would ship a dead `#root`.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RUNTIME_ASSETS_ROOT } from '../runtimeAssetsRoot.js';

/** Marker in the settings webview document, filled at phase 4 (NDL-126 §8.4). */
export const SETTINGS_APP_MARKER = '/*KARST_SETTINGS_APP*/';
export const SETTINGS_APP_CSS_MARKER = '/*KARST_SETTINGS_APP_CSS*/';

/** The settings React app bundle text, read from the runtime assets root. */
export function settingsAppJs(): string {
  return readFileSync(join(RUNTIME_ASSETS_ROOT, 'ui/settings/app.webview.js'), 'utf8').trim();
}

/** App stylesheets, in cascade order: the shared sheet, then the Agents page sheet. */
const SETTINGS_APP_CSS_FILES = ['ui/settings/app.webview.css', 'ui/settings/agents.webview.css'] as const;

export function settingsAppCss(): string {
  return SETTINGS_APP_CSS_FILES.map((file) => {
    try {
      return readFileSync(join(RUNTIME_ASSETS_ROOT, file), 'utf8').trim();
    } catch {
      return '';
    }
  })
    .filter((css) => css !== '')
    .join('\n');
}

/**
 * Replace the app marker with its bundle. A document without the marker is
 * returned unchanged: that is the un-migrated vanilla view, not an error.
 */
export function injectSettingsApp(html: string): string {
  if (!html.includes(SETTINGS_APP_MARKER)) return html;
  let out = html.replace(SETTINGS_APP_MARKER, () => settingsAppJs());
  if (out.includes(SETTINGS_APP_CSS_MARKER)) {
    out = out.replace(SETTINGS_APP_CSS_MARKER, () => settingsAppCss());
  }
  return out;
}