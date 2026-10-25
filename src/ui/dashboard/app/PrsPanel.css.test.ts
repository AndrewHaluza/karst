/** Source-text guards for the Pull requests rules that moved out of webview.html with the panel: they catch DELETION, not visual regression. */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CSS = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'PrsPanel.css'), 'utf8');

describe('PrsPanel.css — guards moved with the rules', () => {
  it('resolves the merged badge and timestamp to the shared series token', () => {
    expect(CSS).toMatch(/\.pr \.pst-merged\{background:var\(--k-series-2\)/);
    expect(CSS).toMatch(/\.pmeta \.pmerged\{color:var\(--k-series-2\)/);
  });

  it('gives every native <summary> disclosure its own focus-visible ring', () => {
    for (const root of ['mgd', 'pcms', 'pcks']) {
      expect(CSS).toMatch(new RegExp(`\\.${root} summary:focus-visible\\{outline:var\\(--k-focus-w\\) solid var\\(--k-focus\\)`));
    }
  });

  it('flashes the copy through a data attribute, never a class the runtime could wipe', () => {
    expect(CSS).toMatch(/\.pr \.url-copy\[data-copied\] \.u\{color:var\(--k-success\)\}/);
    expect(CSS).not.toMatch(/url-copy\.ok/);
  });

  it('keeps the refresh pushed right by its header wrapper', () => {
    expect(CSS).toMatch(/\.prpanel \.phead \.pops\{margin-left:auto/);
  });
});
