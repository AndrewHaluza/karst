/**
 * T1360 review (UI-R29): the Accounts table's painted row surfaces, pinned numerically.
 *
 * `agents.webview.css` paints two surfaces under a row — the theme's hover and
 * inactive-selection washes — and pairs each with its foreground in the same rule
 * (`--k-text`, and `--vscode-list-inactiveSelectionForeground` falling back to
 * `--k-text`). Every dim ink and inline text button in the row inherits that pair,
 * so the ink that can sit on a wash is the theme foreground, not a grey or a link
 * tone. The warning text uses the readable attention tone (`--k-attention-fg`),
 * never the chart hue, which is a fill colour.
 *
 * This recomputes those pairs against the fixed VS Code theme blocks the visual
 * sweep renders (tests/visual/themes.ts), in all three themes. It is the STATIC
 * half of UI-R29; the sweep's a11y walk measures the default page.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { STATUS_FG } from '../../src/model/palette.js';
import { THEMES, THEME_IDS, type ThemeId } from './themes.js';

const CSS = readFileSync('src/ui/settings/agents.webview.css', 'utf8');

/** The declaration block that starts at `start`. */
function block(start: string): string {
  const at = CSS.indexOf(start);
  if (at < 0) throw new Error(`missing rule: ${start}`);
  const open = CSS.indexOf('{', at);
  return CSS.slice(open + 1, CSS.indexOf('}', open));
}

/** One `--vscode-*` value from the fixed theme block. */
function themeVar(theme: ThemeId, name: string): string {
  const css = THEMES[theme].rootCss;
  const at = css.indexOf(`${name}:`);
  if (at < 0) throw new Error(`${name} missing from the ${theme} theme block`);
  const value = css.slice(at + name.length + 1);
  return value.slice(0, value.indexOf(';'));
}

function channels(hex: string): [number, number, number] {
  const h = hex.trim().replace('#', '');
  if (!/^[0-9a-f]{6}$/i.test(h)) throw new Error(`not a 6-digit hex colour: ${hex}`);
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as [number, number, number];
}

function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/** The surfaces a row can put its ink on: the page, the hover wash, the selection tint. */
const SURFACES = [
  '--vscode-editor-background',
  '--vscode-list-hoverBackground',
  '--vscode-list-inactiveSelectionBackground',
] as const;

describe('Accounts row contrast (UI-R29)', () => {
  it.each(THEME_IDS)('%s: the row foreground clears 4.5:1 on every row surface', (theme) => {
    // The row sets `--vscode-list-inactiveSelectionForeground` when the theme
    // defines it and falls back to `--k-text` (`--vscode-foreground`) otherwise.
    // The three fixture themes define only the foreground, so that is the pair.
    const ink = themeVar(theme, '--vscode-foreground');
    for (const surface of SURFACES) {
      expect(contrast(ink, themeVar(theme, surface)), `${ink} on ${surface}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each(THEME_IDS)('%s: the warning tone clears 4.5:1 on the page and both washes', (theme) => {
    // `--k-attention-fg`: the readable attention tone (palette STATUS_FG.attention).
    const tone = theme === 'light' ? STATUS_FG.attention.light : STATUS_FG.attention.dark;
    for (const surface of SURFACES) {
      expect(contrast(tone, themeVar(theme, surface)), `${tone} on ${surface}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('names the readable attention tone and not the chart hue for the warning text', () => {
    const warn = block('#section-agents .accounts-status-warn {');
    expect(warn).toContain('var(--k-attention-fg)');
    expect(warn).not.toContain('var(--k-warning)');
  });
});
