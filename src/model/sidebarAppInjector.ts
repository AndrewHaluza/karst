/**
 * Inject the pre-built sidebar React app bundle into the sidebar document.
 *
 * The app is bundled by esbuild (`scripts/build-webview-send.mjs`) and read as
 * plain text through `RUNTIME_ASSETS_ROOT`, so the runtime text lands verbatim in
 * the document and `injectCsp` can nonce it. When the marker IS present the
 * bundle must exist: a missing bundle THROWS, because a silent fallback would
 * ship a dead `#root`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RUNTIME_ASSETS_ROOT } from '../runtimeAssetsRoot.js';

/** Marker in the sidebar webview document. */
export const SIDEBAR_APP_MARKER = '/*KARST_SIDEBAR_APP*/';

/** The sidebar React app bundle text, read from the runtime assets root. */
export function sidebarAppJs(): string {
  return readFileSync(join(RUNTIME_ASSETS_ROOT, 'ui/sidebar/app.webview.js'), 'utf8').trim();
}

/** Replace the app marker with the bundle. A document without the marker is returned unchanged. */
export function injectSidebarApp(html: string): string {
  if (!html.includes(SIDEBAR_APP_MARKER)) return html;
  return html.replace(SIDEBAR_APP_MARKER, () => sidebarAppJs());
}
