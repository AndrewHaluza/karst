/**
 * Inject the pre-built resources + servers React app bundle into the resources
 * document.
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

/** Marker in the resources webview document. */
export const RESOURCES_APP_MARKER = '/*KARST_RESOURCES_APP*/';

/** Marker for the Servers tab's stylesheet (`servers.webview.css`) in the document. */
export const RESOURCES_APP_CSS_MARKER = '/*KARST_RESOURCES_APP_CSS*/';

/** The resources React app bundle text, read from the runtime assets root. */
export function resourcesAppJs(): string {
  return readFileSync(join(RUNTIME_ASSETS_ROOT, 'ui/resources/app.webview.js'), 'utf8').trim();
}

/** The Servers tab / tab-strip stylesheet, a committed source file shipped next to the bundle. */
export function resourcesAppCss(): string {
  return readFileSync(join(RUNTIME_ASSETS_ROOT, 'ui/resources/servers.webview.css'), 'utf8').trim();
}

/**
 * Replace the app and stylesheet markers with the bundle and the sheet. A document
 * without the app marker is returned unchanged.
 */
export function injectResourcesApp(html: string): string {
  if (!html.includes(RESOURCES_APP_MARKER)) return html;
  let out = html.replace(RESOURCES_APP_MARKER, () => resourcesAppJs());
  if (out.includes(RESOURCES_APP_CSS_MARKER)) {
    out = out.replace(RESOURCES_APP_CSS_MARKER, () => resourcesAppCss());
  }
  return out;
}
