import type { Glyph } from './glyph.js';

/**
 * Decorates the existing status glyph (`glyphFor`, H1 single source) with the two
 * color representations the naming feature needs: a baked-in hex for tinted SVG
 * icons, and a `terminal.ansi*` ThemeColor key for the terminal tab label (the
 * VS Code API accepts only registered theme colors there, not arbitrary hex).
 * This map ONLY decorates the glyph — it never reinvents the glyph logic.
 */
const HEX: Record<Glyph, string> = {
  gray: '#7f8896',
  blue: '#3f8cff',
  amber: '#d99a2b',
  green: '#38a86b',
  red: '#e35555',
};

const THEME_KEY: Record<Glyph, string> = {
  gray: 'terminal.ansiBrightBlack',
  blue: 'terminal.ansiBlue',
  amber: 'terminal.ansiYellow',
  green: 'terminal.ansiGreen',
  red: 'terminal.ansiRed',
};

export function glyphHex(glyph: Glyph): string {
  return HEX[glyph];
}

export function glyphThemeColorKey(glyph: Glyph): string {
  return THEME_KEY[glyph];
}
