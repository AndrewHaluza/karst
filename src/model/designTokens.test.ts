import { describe, it, expect } from 'vitest';
import { DESIGN_TOKENS, tokensCss, tokenNames } from './designTokens.js';

/**
 * The token layer is the whole point of the design system: it is what makes
 * "one meaning, one value" checkable instead of aspirational. These tests are
 * the enforcement (UI-R04, UI-R05).
 */
describe('design tokens', () => {
  it('declares every category the design system documents', () => {
    const names = tokenNames();
    for (const required of [
      '--k-bg',
      '--k-surface',
      '--k-surface-selected',
      '--k-border',
      '--k-text',
      '--k-text-dim',
      '--k-action-bg',
      '--k-action-fg',
      '--k-focus',
      '--k-success',
      '--k-warning',
      '--k-danger',
      '--k-info',
      '--k-space-4',
      '--k-radius-sm',
      '--k-text-md',
      '--k-font-ui',
      '--k-font-mono',
      '--k-elev-2',
      '--k-dur-fast',
      '--k-dur-spin',
      '--k-ease-standard',
      '--k-border-w',
      '--k-hit-min',
      '--k-z-toast',
    ]) {
      expect(names, `missing ${required}`).toContain(required);
    }
  });

  it('names every token by meaning, never by its value or hue', () => {
    for (const name of tokenNames()) {
      expect(name, `${name} is named for appearance`).not.toMatch(
        /--k-(red|green|blue|yellow|purple|orange|grey|gray|white|black)\b/,
      );
      // `--k-space-8px` would be a token that can never change.
      expect(name, `${name} bakes a unit into its name`).not.toMatch(/\d(px|rem|ms)$/);
    }
  });

  it('routes every feedback colour onto the existing status ramp', () => {
    // The six greens were six independent "success" decisions. There is now one
    // place to make that decision, and it is `model/palette.ts`.
    expect(DESIGN_TOKENS['--k-success']).toBe('var(--k-passed)');
    expect(DESIGN_TOKENS['--k-warning']).toBe('var(--k-attention)');
    expect(DESIGN_TOKENS['--k-danger']).toBe('var(--k-failed)');
    expect(DESIGN_TOKENS['--k-info']).toBe('var(--k-running)');
  });

  it('routes the row highlight onto the platform list selection, never a status colour', () => {
    // A row that was just acted on is SELECTED, not "passed": borrowing
    // --k-success there is what put a green box (and a check badge) around a
    // clicked file row. The inactive selection wash is the one VS Code themes
    // guarantee readable against the default foreground.
    expect(DESIGN_TOKENS['--k-surface-selected']).toContain('--vscode-list-inactiveSelectionBackground');
    expect(DESIGN_TOKENS['--k-surface-selected']).not.toContain('--k-passed');
    expect(DESIGN_TOKENS['--k-surface-selected']).not.toContain('--k-success');
  });

  it('never redeclares a status or stage token it only consumes', () => {
    for (const owned of ['--k-pending', '--k-running', '--k-attention', '--k-passed', '--k-failed']) {
      expect(tokenNames(), `${owned} belongs to model/palette.ts`).not.toContain(owned);
    }
  });

  it('gives each raw colour value exactly one token', () => {
    // The defect this replaces: six greens, five reds, three purples — and the
    // same VS Code variable written with two different fallback hexes.
    const colours = Object.entries(DESIGN_TOKENS).filter(([, v]) => /#[0-9a-fA-F]{3,8}|rgba?\(/.test(v));
    const byValue = new Map<string, string[]>();
    for (const [name, value] of colours) {
      const key = value.replace(/\s+/g, '');
      byValue.set(key, [...(byValue.get(key) ?? []), name]);
    }
    for (const [value, names] of byValue) {
      expect(names.length, `${value} is reachable through ${names.join(', ')}`).toBe(1);
    }
  });

  it('never resolves one VS Code variable to two different fallbacks', () => {
    // `var(--vscode-testing-iconPassed, #73c991)` in diffs and
    // `var(--vscode-testing-iconPassed, #3fb950)` in welcome rendered two
    // different colours from one variable on a theme that omits it.
    const fallbackFor = new Map<string, string>();
    for (const [name, value] of Object.entries(DESIGN_TOKENS)) {
      for (const [, vscodeVar, fallback] of value.matchAll(
        /var\(\s*(--vscode-[\w-]+)\s*,\s*(#[0-9a-fA-F]{3,8})\s*\)/g,
      )) {
        const seen = fallbackFor.get(vscodeVar!);
        if (seen !== undefined) {
          expect(seen, `${vscodeVar} has two fallbacks (via ${name})`).toBe(fallback);
        }
        fallbackFor.set(vscodeVar!, fallback!);
      }
    }
  });

  it('keeps the spacing scale closed and ordered', () => {
    const steps = tokenNames()
      .filter((n) => n.startsWith('--k-space-'))
      .map((n) => Number(DESIGN_TOKENS[n]!.replace('px', '')));
    expect(steps.length).toBeGreaterThanOrEqual(9);
    expect([...steps].sort((a, b) => a - b)).toEqual(steps);
    // 1px is a border width, not a spacing step — keeping it out is what stops
    // `--k-space-1` from being used for a hairline.
    expect(steps).not.toContain(1);
  });

  it('drops the rounding-noise type sizes rather than tokenizing them', () => {
    const sizes = tokenNames()
      .filter((n) => /^--k-text-(2xs|xs|sm|md|lg|xl|2xl)$/.test(n))
      .map((n) => DESIGN_TOKENS[n]!);
    for (const noise of ['9px', '9.5px', '10.5px', '12.5px']) {
      expect(sizes, `${noise} was rounding noise, not intent`).not.toContain(noise);
    }
  });

  it('emits one :root block with every token and nothing else', () => {
    const css = tokensCss();
    expect(css.startsWith(':root{')).toBe(true);
    expect(css.endsWith('}')).toBe(true);
    for (const [name, value] of Object.entries(DESIGN_TOKENS)) {
      expect(css).toContain(`${name}:${value};`);
    }
    // One declaration per token — a duplicate would mean the later one silently wins.
    for (const name of tokenNames()) {
      expect(css.split(`${name}:`).length - 1, `${name} declared twice`).toBe(1);
    }
  });
});
