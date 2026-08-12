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

/**
 * Strip `//# sourceMappingURL=...` trailer comments. The npm bundles end with
 * one each, and the `.map` files are deliberately NOT shipped — so the comment
 * would make the browser fetch `vscode-webview://<id>/xterm.js.map` on every
 * load, a request that violates the webview's `default-src 'none'` and lands a
 * console violation for a file that does not exist. The strip is a delivery
 * concern, applied at the read seam so the injected text is what the webview
 * will actually execute.
 */
const SOURCE_MAP_TRAILER = /^\/\/# sourceMappingURL=.*$/gm;

function stripSourceMapTrailers(text: string): string {
  return text.replace(SOURCE_MAP_TRAILER, '').trimEnd();
}

/** Read the three vendored files; js is the two UMD bundles concatenated. */
export function readXtermAssets(dir: string): XtermAssets {
  return {
    css: readFileSync(join(dir, 'xterm.css'), 'utf8'),
    js:
      stripSourceMapTrailers(readFileSync(join(dir, 'xterm.js'), 'utf8')) +
      '\n' +
      stripSourceMapTrailers(readFileSync(join(dir, 'addon-fit.js'), 'utf8')),
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
