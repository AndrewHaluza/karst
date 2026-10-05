import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * xterm.js delivery. Still no `<link>` or `<script src>` (CSP `default-src
 * 'none'` + nonce-only scripts; the asWebviewUri path is documented as
 * deliberately unused in designSystem.ts), but split by size:
 *
 *  - the small stylesheet is inlined at a marker, like the design system;
 *  - the ~490 KB bundle is NOT in the document. Over Remote-SSH the document
 *    crosses the network on every panel open, and only the console uses
 *    xterm, so the webview asks for it on first console open
 *    (`xterm-request`) and runs the `xterm` answer as an inline script tagged
 *    with its own nonce.
 *
 * The vendored files are npm devDependencies copied to `dist/vendor/xterm/` by
 * scripts/copy-assets.mjs and read once per dashboard host.
 */

export const XTERM_CSS_MARKER = '/*KARST_XTERM_CSS*/';

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
 * Replace the css marker. A function replacer, never a string: `String.replace`
 * treats `$&`, `$'` and friends in a string replacement as substitutions, and
 * the vendored text must land verbatim. No-op if the marker is absent.
 */
export function injectXtermCss(html: string, css: string): string {
  return html.replace(XTERM_CSS_MARKER, () => css);
}

/**
 * The host's answer to `xterm-request`. `null` assets (a packaging regression)
 * answer `js: null`, which the console renders as its visible refusal.
 */
export function xtermMessage(assets: XtermAssets | null): { type: 'xterm'; js: string | null } {
  return { type: 'xterm', js: assets ? assets.js : null };
}
