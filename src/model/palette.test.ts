import { describe, it, expect } from 'vitest';
import { paletteCss, injectPalette, PALETTE_MARKER, STATUS_FG } from './palette.js';

/** WCAG 2.1 relative luminance, the same math the a11y gate (`tests/visual/a11y.visual.ts`) runs. */
function luminance(hex: string): number {
  const h = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

describe('paletteCss', () => {
  const css = paletteCss();

  it('defines the five canonical semantic tokens', () => {
    for (const tok of ['--k-pending', '--k-running', '--k-attention', '--k-passed', '--k-failed']) {
      expect(css).toContain(`${tok}:`);
    }
  });

  it('uses exactly one green and one gray (the divergence this fixes)', () => {
    // charts-green is the single passed/done/online green; charts-lines the single gray.
    expect(css).toContain('--k-passed:var(--vscode-charts-green, #4bb64b)');
    expect(css).toContain('--k-pending:var(--vscode-charts-lines, #6e7681)');
    // The stray ticket-form green (#3fb950) and sidebar gray (#8b8b8b) must not appear.
    expect(css).not.toContain('#3fb950');
    expect(css).not.toContain('#8b8b8b');
  });

  it('defines the five findings-severity tokens as var(--k-*) references', () => {
    const sevTokens = ['--k-sev-critical', '--k-sev-high', '--k-sev-medium', '--k-sev-low', '--k-sev-info'];
    for (const tok of sevTokens) {
      expect(css).toContain(`${tok}:var(--k-`);
    }
  });

  it('aliases the legacy --g-*/--st-* names to the unified tokens', () => {
    expect(css).toContain('--g-done:var(--k-passed)');
    expect(css).toContain('--st-done:var(--k-passed)');
    expect(css).toContain('--st-pending:var(--k-pending)');
    expect(css).toContain('--g-gray:var(--k-pending)');
  });

  it('emits a readable glyph tone for every state, with its light-theme override (UI-R28b, UI-R29)', () => {
    for (const kind of ['pending', 'running', 'attention', 'passed', 'failed'] as const) {
      expect(css).toContain(`--k-${kind}-fg:${STATUS_FG[kind].dark};`);
      expect(css).toContain(`--k-${kind}-fg:${STATUS_FG[kind].light}`);
    }
  });
});

describe('status glyph tones (UI-R28b, UI-R29)', () => {
  // The surfaces the a11y gate measures the marker on: the pinned themes' `--vscode-sideBar-background`
  // (tests/visual/themes.ts: dark #252526, light #f3f3f3). hc is black, where the dark tones clear too.
  const SURFACES = { dark: '#252526', light: '#f3f3f3', hc: '#000000' } as const;

  it.each(Object.entries(SURFACES))('every state glyph clears 4.5:1 on the %s sidebar surface', (theme, bg) => {
    const tones = theme === 'light' ? 'light' : 'dark';
    for (const kind of ['pending', 'running', 'attention', 'passed', 'failed'] as const) {
      const ratio = contrast(STATUS_FG[kind][tones], bg);
      expect(ratio, `${kind} ${tones} glyph on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('injectPalette', () => {
  it('replaces the marker with the palette style block', () => {
    const out = injectPalette(`<style>${PALETTE_MARKER}</style>`);
    expect(out).not.toContain(PALETTE_MARKER);
    expect(out).toContain('--k-passed');
  });

  it('is a no-op when the marker is absent', () => {
    expect(injectPalette('<div>no marker</div>')).toBe('<div>no marker</div>');
  });
});
