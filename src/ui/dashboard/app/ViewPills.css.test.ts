/** Source-text guard: the pill row must not be an overflow container above 700px, or it clips the Console stream menu. */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CSS = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'ViewPills.css'), 'utf8');

describe('ViewPills.css — the stream menu is never clipped', () => {
  it('does not scroll the row outside the narrow tier', () => {
    const base = /\.vp-bar\{([^}]*)\}/.exec(CSS)?.[1] ?? '';
    expect(base).not.toMatch(/overflow/);
    expect(CSS).toMatch(/@container \(max-width:699px\)\{[^@]*\.vp-bar\{overflow-x:auto/);
  });

  it('fixes the menu to the frame wherever the row scrolls', () => {
    expect(CSS).toMatch(/@container \(max-width:699px\)\{[^@]*\.vp-menu\{position:fixed/);
  });
});
