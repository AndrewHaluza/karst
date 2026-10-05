import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { injectCsp, newNonce } from '../model/csp.js';
import { injectXtermCss, XTERM_CSS_MARKER } from '../model/xtermAssets.js';
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
  it('the css marker is carried by the dashboard only (the console surface lives there)', () => {
    for (const name of WEBVIEWS) {
      const html = read(name);
      if (name === 'dashboard') expect(html, 'dashboard css marker').toContain(XTERM_CSS_MARKER);
      else expect(html, `${name} css marker`).not.toContain(XTERM_CSS_MARKER);
    }
  });

  it('no webview inlines the xterm bundle — it is delivered on first console open', () => {
    // Over Remote-SSH the document crosses the network on EVERY panel open;
    // the ~490 KB bundle only the console uses rides an `xterm` message instead.
    for (const name of WEBVIEWS) {
      expect(read(name), `${name} js marker`).not.toContain('/*KARST_XTERM_JS*/');
    }
  });

  it('keeps the dashboard CSP-compliant after injection', () => {
    const injected = injectCsp(injectXtermCss(read('dashboard'), '.xterm{}'), 'TESTNONCE');
    expect(injected).toContain("default-src 'none'");
    expect(injected).not.toMatch(/<script(?![^>]*\bnonce=)/);
    expect(injected).not.toMatch(/<link\b/);
    expect(injected).not.toMatch(/<script[^>]*\bsrc=/);
  });
});

describe('xterm host wiring', () => {
  const ROOT = join(HERE, '..', '..');
  // The dashboard host adapter owns the read and the answer (NDL-33
  // standardized every screen's activation-layer wiring into its own host.ts).
  const DASHBOARD_HOST = readFileSync(join(ROOT, 'src', 'ui', 'dashboard', 'host.ts'), 'utf8');

  it('reads the vendored assets once, inlines only the css, and answers xterm-request', () => {
    expect(DASHBOARD_HOST).toMatch(/readXtermAssets\(join\(RUNTIME_ASSETS_ROOT, 'vendor', 'xterm'\)\)/);
    expect(DASHBOARD_HOST).toMatch(/injectXtermCss\(/);
    expect(DASHBOARD_HOST).toMatch(/'xterm-request'[\s\S]{0,200}xtermMessage\(/);
  });

  it('degrades to a null bundle when the vendor assets are missing', () => {
    // A packaging regression must not take the whole dashboard down: the read
    // is wrapped, and a null bundle renders the visible "unavailable" refusal.
    expect(DASHBOARD_HOST).toMatch(/try \{[\s\S]{0,400}readXtermAssets\(join\(RUNTIME_ASSETS_ROOT, 'vendor', 'xterm'\)\)[\s\S]{0,200}catch/);
  });
});
