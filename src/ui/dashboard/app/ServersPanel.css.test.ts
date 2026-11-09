/** Source-text guards for the Servers panel rules: they catch DELETION, not visual regression. */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CSS = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'ServersPanel.css'), 'utf8');

describe('ServersPanel.css — guards moved with the rules', () => {
  it('scopes containment to the servers panel and compacts it by container width', () => {
    expect(CSS).toMatch(/\.svpanel\{[^}]*container-type:inline-size/);
    expect(CSS).toMatch(/@container \(max-width: ?400px\)/);
    expect(CSS).toMatch(/\.svpanel \.srvaddr \.short\{display:inline\}/);
  });

  it('keeps the status shapes distinct from colour, and lets the shared note wrap', () => {
    expect(CSS).toMatch(/\.glyph\.off\{[^}]*border:calc\(var\(--k-border-w\) \* 2\) solid/);
    expect(CSS).toMatch(/\.glyph\.failed\{[^}]*background:var\(--k-danger\)/);
    expect(CSS).toMatch(/\.svpanel \.srvbranch\{[^}]*white-space:normal/);
  });

  it('says a failed row in danger and an offline row dim, and flashes the copy through a data attribute', () => {
    expect(CSS).toMatch(/\.srvword\.failed\{color:var\(--k-danger\)\}/);
    expect(CSS).toMatch(/\.srvword\.off\{color:var\(--k-text-dim\)\}/);
    expect(CSS).toMatch(/\.ib\[data-copied\]\{color:var\(--k-passed\)\}/);
  });
});
