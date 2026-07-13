import { describe, it, expect } from 'vitest';
import { paletteCss, injectPalette, PALETTE_MARKER } from './palette.js';

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
    // The stray onboarding green (#3fb950) and sidebar gray (#8b8b8b) must not appear.
    expect(css).not.toContain('#3fb950');
    expect(css).not.toContain('#8b8b8b');
  });

  it('aliases the legacy --g-*/--st-* names to the unified tokens', () => {
    expect(css).toContain('--g-done:var(--k-passed)');
    expect(css).toContain('--st-done:var(--k-passed)');
    expect(css).toContain('--st-pending:var(--k-pending)');
    expect(css).toContain('--g-gray:var(--k-pending)');
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
