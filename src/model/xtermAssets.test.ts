import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { injectXterm, readXtermAssets, XTERM_CSS_MARKER, XTERM_JS_MARKER } from './xtermAssets.js';

describe('xterm asset injection', () => {
  it('replaces both markers with the asset text via function replacers ($&-safe)', () => {
    // The replacement must land VERBATIM: String.replace would treat `$&`/`$'`
    // in a string replacement as substitutions, and the vendored JS is full of
    // `$'`-shaped text (minified source).
    const html = `<style>${XTERM_CSS_MARKER}</style><script>${XTERM_JS_MARKER}</script>`;
    const css = '.xterm{color:red}';
    const js = "var a = '$&'; var b = \"$'\";";
    const out = injectXterm(html, { css, js });
    expect(out).toContain('<style>.xterm{color:red}</style>');
    expect(out).toContain(`var a = '$&'; var b = "$'";`);
    expect(out).not.toContain(XTERM_JS_MARKER);
    expect(out).not.toContain(XTERM_CSS_MARKER);
  });

  it('is a no-op per marker when absent (same contract as injectPalette)', () => {
    const html = '<style>/*KARST_DS_CSS*/</style><script>run();</script>';
    expect(injectXterm(html, { css: 'c', js: 'j' })).toBe(html);
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

  it('throws the raw fs error when a vendor file is missing', () => {
    writeFileSync(join(dir, 'xterm.js'), 'x');
    writeFileSync(join(dir, 'addon-fit.js'), 'f');
    expect(() => readXtermAssets(dir)).toThrow(/ENOENT|xterm\.css/);
  });
});
