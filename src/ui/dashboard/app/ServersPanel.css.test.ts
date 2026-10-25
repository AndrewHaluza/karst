/** Source-text guards for the Servers panel rules that moved out of webview.html with the panel: they catch DELETION, not visual regression. */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CSS = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'ServersPanel.css'), 'utf8');

describe('ServersPanel.css — guards moved with the rules', () => {
  it('scopes containment to the servers panel and compacts it by container width', () => {
    expect(CSS).toMatch(/\.svpanel\{[^}]*container-type:inline-size/);
    expect(CSS).toMatch(/@container \(max-width: ?400px\)/);
    // The specificity trap: the reset must re-qualify the class or the 1% action column survives into narrow.
    expect(CSS).toMatch(/td\.c-acts\{[^}]*width:auto/);
  });

  it('keeps the status shapes distinct from colour, and wraps the shared meta line', () => {
    expect(CSS).toMatch(/\.glyph\.off\{[^}]*border:calc\(var\(--k-border-w\) \* 2\) solid/);
    expect(CSS).toMatch(/\.glyph\.failed\{[^}]*background:var\(--k-danger\)/);
    expect(CSS).toMatch(/\.svpanel td\.c-name \.srvmeta\{[^}]*white-space:normal/);
  });

  it('right-aligns the Actions header and flashes the copy through a data attribute', () => {
    expect(CSS).toMatch(/\.svpanel thead th:last-child\{text-align:right\}/);
    expect(CSS).toMatch(/\.ib\[data-copied\]\{color:var\(--k-passed\)\}/);
  });
});
