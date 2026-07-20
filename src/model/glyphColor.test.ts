import { describe, it, expect } from 'vitest';
import type { Glyph } from './glyph.js';
import { glyphHex, glyphThemeColorKey } from './glyphColor.js';

const ALL: Glyph[] = ['gray', 'blue', 'amber', 'green', 'red'];

describe('glyphColor', () => {
  it('maps every glyph to a distinct 6-digit hex', () => {
    const hexes = ALL.map(glyphHex);
    for (const h of hexes) expect(h).toMatch(/^#[0-9a-f]{6}$/);
    expect(new Set(hexes).size).toBe(ALL.length);
  });

  it('maps every glyph to a terminal.ansi* theme key', () => {
    for (const g of ALL) expect(glyphThemeColorKey(g)).toMatch(/^terminal\.ansi/);
  });

  it('pairs red with the red hex and ansiRed', () => {
    expect(glyphHex('red')).toBe('#e35555');
    expect(glyphThemeColorKey('red')).toBe('terminal.ansiRed');
  });
});
