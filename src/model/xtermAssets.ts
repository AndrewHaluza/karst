import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * xterm.js delivery — the SAME mechanism as the design system: a marker in the
 * HTML, a module emitting text, one host-side inject call. No second delivery
 * mechanism (CSP `default-src 'none'` + nonce-only scripts forbid a `<link>` or
 * `<script src>`; the asWebviewUri path is documented as deliberately unused in
 * designSystem.ts). The vendored files are npm devDependencies copied to
 * `dist/vendor/xterm/` by scripts/copy-assets.mjs; `dashboardWebviewHtml()`
 * reads them and injects BEFORE `injectCsp`, so the nonce pass tags the script.
 */

export const XTERM_CSS_MARKER = '/*KARST_XTERM_CSS*/';
export const XTERM_JS_MARKER = '/*KARST_XTERM_JS*/';

export interface XtermAssets {
  css: string;
  js: string;
}

/** Read the three vendored files; js is the two UMD bundles concatenated. */
export function readXtermAssets(dir: string): XtermAssets {
  return {
    css: readFileSync(join(dir, 'xterm.css'), 'utf8'),
    js:
      readFileSync(join(dir, 'xterm.js'), 'utf8') +
      '\n' +
      readFileSync(join(dir, 'addon-fit.js'), 'utf8'),
  };
}

/**
 * Replace both markers. Function replacers, never strings: `String.replace`
 * treats `$&`, `$'` and friends in a string replacement as substitutions, and
 * the vendored JS must land verbatim. No-op per marker if absent.
 */
export function injectXterm(html: string, assets: XtermAssets): string {
  return html
    .replace(XTERM_CSS_MARKER, () => assets.css)
    .replace(XTERM_JS_MARKER, () => assets.js);
}
