import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { injectCsp, newNonce } from '../model/csp.js';
import { injectXterm, XTERM_CSS_MARKER, XTERM_JS_MARKER } from '../model/xtermAssets.js';
const HERE = dirname(fileURLToPath(import.meta.url));

// Discovered, never enumerated — the same discipline as ui/webviewCsp.test.ts:
// a webview added later must not be able to ship with (or without) xterm
// markers silently.
const WEBVIEWS = readdirSync(HERE, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .filter((name) => {
    try {
      readFileSync(join(HERE, name, 'webview.html'));
      return true;
    } catch {
      return false;
    }
  });

const read = (name: string): string => readFileSync(join(HERE, name, 'webview.html'), 'utf8');

describe('xterm markers', () => {
  it('are carried by the dashboard only (the console surface lives there)', () => {
    for (const name of WEBVIEWS) {
      const html = read(name);
      if (name === 'dashboard') {
        expect(html, 'dashboard css marker').toContain(XTERM_CSS_MARKER);
        expect(html, 'dashboard js marker').toContain(XTERM_JS_MARKER);
      } else {
        expect(html, `${name} css marker`).not.toContain(XTERM_CSS_MARKER);
        expect(html, `${name} js marker`).not.toContain(XTERM_JS_MARKER);
      }
    }
  });

  it('keep the dashboard CSP-compliant after injection (nonce covers the xterm script)', () => {
    const injected = injectCsp(
      injectXterm(read('dashboard'), { css: '.xterm{}', js: 'var xterm = 1;' }),
      'TESTNONCE',
    );
    // default-src stays 'none' and every script — including the injected
    // xterm block — carries the nonce.
    expect(injected).toContain("default-src 'none'");
    expect(injected).not.toMatch(/<script(?![^>]*\bnonce=)/);
    // The injected content introduces no external load.
    expect(injected).not.toMatch(/<link\b/);
    expect(injected).not.toMatch(/<script[^>]*\bsrc=/);
  });
});

describe('xterm host wiring', () => {
  const ROOT = join(HERE, '..', '..');
  const EXTENSION = readFileSync(join(ROOT, 'src', 'extension.ts'), 'utf8');

  it('injects the vendored bundles into the dashboard asset before CSP runs', () => {
    // The one host-side inject call — the markers must not survive to the
    // panel (they are comments; the console view would read "unavailable"
    // while the assets sit unused in dist/vendor/xterm). injectXterm runs
    // inside dashboardWebviewHtml and injectCsp is applied at panel creation,
    // so the nonce pass tags the vendored script (xterm.test.ts above pins the
    // resulting document's CSP compliance).
    expect(EXTENSION).toMatch(/injectXterm\(html, readXtermAssets\(join\(HERE, 'vendor', 'xterm'\)\)\)/);
  });

  it('degrades to the marker comments when the vendor assets are missing', () => {
    // A packaging regression must not take the whole dashboard down: the read
    // is wrapped so a missing bundle leaves the markers in place, which the
    // webview already renders as a visible "console unavailable" refusal.
    expect(EXTENSION).toMatch(/try \{[\s\S]{0,400}readXtermAssets\(join\(HERE, 'vendor', 'xterm'\)\)[\s\S]{0,200}catch/);
  });
});
