/**
 * Inject the pre-built dashboard React app bundle into the dashboard document.
 *
 * The app is bundled by esbuild (`scripts/build-webview-send.mjs`) and read as
 * plain text through `RUNTIME_ASSETS_ROOT`, so the runtime text lands verbatim
 * in the document and `injectCsp` can nonce it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RUNTIME_ASSETS_ROOT } from '../runtimeAssetsRoot.js';

/** Marker in the dashboard webview document. */
export const DASHBOARD_APP_MARKER = '/*KARST_DASHBOARD_APP*/';
export const DASHBOARD_APP_CSS_MARKER = '/*KARST_DASHBOARD_APP_CSS*/';

/** The dashboard React app bundle text, read from the runtime assets root. */
export function dashboardAppJs(): string {
  return readFileSync(join(RUNTIME_ASSETS_ROOT, 'ui/dashboard/app.webview.js'), 'utf8').trim();
}

/** App stylesheets, in cascade order. */
const DASHBOARD_APP_CSS_FILES = ['ui/dashboard/app.webview.css'] as const;

export function dashboardAppCss(): string {
  return DASHBOARD_APP_CSS_FILES.map((file) => {
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
export function injectDashboardApp(html: string): string {
  if (!html.includes(DASHBOARD_APP_MARKER)) return html;
  let out = html.replace(DASHBOARD_APP_MARKER, () => dashboardAppJs());
  if (out.includes(DASHBOARD_APP_CSS_MARKER)) {
    out = out.replace(DASHBOARD_APP_CSS_MARKER, () => dashboardAppCss());
  }
  return out;
}
