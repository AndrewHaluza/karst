import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { injectXtermCss, readXtermAssets, xtermMessage, XTERM_CSS_MARKER } from './xtermAssets.js';

describe('xterm asset injection', () => {
  it('replaces the css marker with the stylesheet via a function replacer ($&-safe)', () => {
    // The replacement must land VERBATIM: String.replace would treat `$&`/`$'`
    // in a string replacement as substitutions.
    const html = `<style>${XTERM_CSS_MARKER}</style>`;
    const out = injectXtermCss(html, ".xterm{content:'$&'}");
    expect(out).toBe(".xterm{content:'$&'}".replace(/^/, '<style>') + '</style>');
    expect(out).not.toContain(XTERM_CSS_MARKER);
  });

  it('is a no-op when the marker is absent (same contract as injectPalette)', () => {
    const html = '<style>/*KARST_DS_CSS*/</style><script>run();</script>';
    expect(injectXtermCss(html, 'c')).toBe(html);
  });
});

describe('xtermMessage', () => {
  it('answers an xterm-request with the bundle text', () => {
    expect(xtermMessage({ css: 'c', js: 'var t = 1;' })).toEqual({ type: 'xterm', js: 'var t = 1;' });
  });

  it('answers with js: null when the vendor assets are missing (console degrades visibly)', () => {
    expect(xtermMessage(null)).toEqual({ type: 'xterm', js: null });
  });
});

describe('readXtermAssets', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'karst-xterm-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('concatenates xterm.js and addon-fit.js after the css', () => {
    writeFileSync(join(dir, 'xterm.css'), 'css-body');
    writeFileSync(join(dir, 'xterm.js'), 'xterm-body');
    writeFileSync(join(dir, 'addon-fit.js'), 'fit-body');
    expect(readXtermAssets(dir)).toEqual({ css: 'css-body', js: 'xterm-body\nfit-body' });
  });

  it('strips //# sourceMappingURL trailers the bundles ship with', () => {
    // The npm bundles end with a sourceMappingURL comment; the .map files are
    // not shipped, and the browser would fetch them against the webview origin
    // — a request `default-src 'none'` blocks. The read seam strips them.
    writeFileSync(join(dir, 'xterm.css'), 'css-body');
    writeFileSync(join(dir, 'xterm.js'), 'xterm-body\n//# sourceMappingURL=xterm.js.map');
    writeFileSync(join(dir, 'addon-fit.js'), 'fit-body\n//# sourceMappingURL=addon-fit.js.map');
    expect(readXtermAssets(dir).js).toBe('xterm-body\nfit-body');
    expect(readXtermAssets(dir).js).not.toContain('sourceMappingURL');
  });

  it('throws the raw fs error when a vendor file is missing', () => {
    writeFileSync(join(dir, 'xterm.js'), 'x');
    writeFileSync(join(dir, 'addon-fit.js'), 'f');
    expect(() => readXtermAssets(dir)).toThrow(/ENOENT|xterm\.css/);
  });
});
