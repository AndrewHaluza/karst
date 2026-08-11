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
