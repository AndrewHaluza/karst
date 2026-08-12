import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { mkdtempSync, copyFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { readXtermAssets } from '../model/xtermAssets.js';

// node_modules is a build/test-time presence; the extension itself reads
// dist/vendor/xterm (copied by scripts/copy-assets.mjs from these files).
// The package ships its bundles split across lib/ (js) and css/ (css), so
// they are staged flat into a temp dir — the same shape dist/vendor/xterm
// has at runtime — before readXtermAssets reads them.
//
// The bundles are located through Node's OWN resolution, never by a path
// relative to this source file: the UAT gate runs the suite from a linked
// worktree whose node_modules is empty, and packages resolve by walking up
// to the main checkout (the same resolution every import in this suite
// uses). A `../../node_modules/@xterm` literal exists only in a main
// checkout and fails the gate in the worktree it is run from.
const require = createRequire(import.meta.url);
const VENDOR = dirname(dirname(require.resolve('@xterm/xterm/package.json')));

describe('vendored xterm bundles are CSP-safe to inline', () => {
  let assets: ReturnType<typeof readXtermAssets>;
  let tmp: string;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'karst-xterm-vendor-'));
    copyFileSync(join(VENDOR, 'xterm', 'lib', 'xterm.js'), join(tmp, 'xterm.js'));
    copyFileSync(join(VENDOR, 'xterm', 'css', 'xterm.css'), join(tmp, 'xterm.css'));
    copyFileSync(join(VENDOR, 'addon-fit', 'lib', 'addon-fit.js'), join(tmp, 'addon-fit.js'));
    assets = readXtermAssets(tmp);
  });

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('keeps the bundles within their delivery budgets', () => {
    const js = assets.js;
    const css = assets.css;
    // xterm.js UMD is ~489 KB, addon-fit ~1.5 KB, css ~7 KB. The bounds are
    // generous slack; a package that swaps to a different bundle format (e.g.
    // an ESM-only build or an unbundled tree) will trip one of them.
    expect(js.length).toBeGreaterThan(100_000);
    expect(js.length).toBeLessThan(700_000);
    expect(css.length).toBeGreaterThan(1_000);
    expect(css.length).toBeLessThan(50_000);
  });

  it('contains no <script literal (injectCsp nonces by replaceAll of <script>)', () => {
    // injectCsp does html.replaceAll('<script>', '<script nonce=...>') over the
    // WHOLE document — a literal `<script` inside the vendored JS would either
    // get corrupted or leave an untagged script. The source `webview.html`
    // cannot carry the content, so this is the test that pins it.
    expect(assets.js).not.toContain('<script');
    expect(assets.js).not.toContain('</script');
  });

  it('contains no eval or Function constructor (nonce CSP blocks them silently)', () => {
    expect(assets.js).not.toMatch(/\beval\(|new Function\(/);
  });

  it('contains no external url() or font-face (default-src none)', () => {
    expect(assets.css).not.toMatch(/url\(/);
    expect(assets.css).not.toMatch(/@font-face/);
  });

  it('is a UMD bundle that attaches to the global object', () => {
    // The dashboard script reads `Terminal`/`FitAddon` as bare globals after
    // the injected block runs. The UMD wrapper assigns its exports onto
    // globalThis in a browser (no module/exports/define present).
    expect(assets.js).toContain('globalThis');
    expect(assets.js).toContain('exports');
  });

  it('carries a sourceMappingURL trailer that the delivery seam strips', () => {
    // The .map files are not shipped and the webview CSP is `default-src
    // 'none'`: an injected trailer would make the browser fetch
    // vscode-webview://<id>/xterm.js.map and log a blocked-request violation
    // for a file that does not exist. readXtermAssets strips these lines; this
    // pins BOTH facts — the raw bundle carries the trailer (so the strip is
    // load-bearing) and the delivered text has none.
    const raw = readFileSync(join(VENDOR, 'xterm', 'lib', 'xterm.js'), 'utf8')
      + '\n'
      + readFileSync(join(VENDOR, 'addon-fit', 'lib', 'addon-fit.js'), 'utf8');
    expect(raw).toMatch(/\/\/# sourceMappingURL=xterm\.js\.map$/m);
    expect(raw).toMatch(/\/\/# sourceMappingURL=addon-fit\.js\.map$/m);
    expect(assets.js).not.toContain('sourceMappingURL');
  });
});
