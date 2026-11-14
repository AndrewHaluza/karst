import { describe, it, expect } from 'vitest';
import { STAGE_KEYS } from './types.js';
import {
  STAGE_COLORS,
  STAGE_FALLBACK_KEY,
  stageColorClass,
  stagePaletteCss,
} from './stagePalette.js';
import { ATTENTION_FG, PALETTE_TOKENS, paletteCss } from './palette.js';

/** WCAG relative-luminance contrast ratio between two `#rrggbb` hexes. */
function contrastRatio(hexA: string, hexB: string): number {
  const luminance = (hex: string): number => {
    const channels = hex
      .slice(1)
      .match(/.{2}/g)!
      .map((pair) => parseInt(pair, 16) / 255);
    const linear = channels.map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
  };
  const [hi, lo] = [luminance(hexA), luminance(hexB)].sort((a, b) => b - a) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe('STAGE_COLORS', () => {
  it('covers every stage in the graph', () => {
    for (const key of STAGE_KEYS) expect(STAGE_COLORS[key]).toBeDefined();
  });

  it('gives each stage a distinct hue in both themes', () => {
    const dark = STAGE_KEYS.map((k) => STAGE_COLORS[k].dark);
    const light = STAGE_KEYS.map((k) => STAGE_COLORS[k].light);
    expect(new Set(dark).size).toBe(STAGE_KEYS.length);
    expect(new Set(light).size).toBe(STAGE_KEYS.length);
  });

  it('keeps impl off the running-status blue — a row must not read blue twice', () => {
    // The status ramp answers "does this need me?", the stage answers "where is
    // it?". Reusing running-blue for `impl` made one row carry the same color
    // for two unrelated claims.
    expect(PALETTE_TOKENS.running).toContain('#3794ff');
    expect(STAGE_COLORS.impl.dark).not.toBe('#3794ff');
  });
});

describe('Scope steel palette (869ej2cfz)', () => {
  it('uses the approved cool-gray/steel pair in both themes', () => {
    expect(STAGE_COLORS.scope).toMatchObject({
      dark: '#8FA3B8',
      light: '#526A80',
      bg: { dark: '#29343D', light: '#EAEDF0' },
    });
  });

  it('leaves every other stage colour untouched — only Scope changes', () => {
    expect({ dark: STAGE_COLORS.impl.dark, light: STAGE_COLORS.impl.light }).toEqual({ dark: '#7f7bf5', light: '#4f46e5' });
    expect({ dark: STAGE_COLORS.uat.dark, light: STAGE_COLORS.uat.light }).toEqual({ dark: '#d18616', light: '#b45309' });
    expect({ dark: STAGE_COLORS.review.dark, light: STAGE_COLORS.review.light }).toEqual({ dark: '#2ea8b5', light: '#0e7490' });
    expect({ dark: STAGE_COLORS.fix.dark, light: STAGE_COLORS.fix.light }).toEqual({ dark: '#f14c4c', light: '#c93636' });
    expect({ dark: STAGE_COLORS.ship.dark, light: STAGE_COLORS.ship.light }).toEqual({ dark: '#d162c4', light: '#bf3989' });
    expect({ dark: STAGE_COLORS.done.dark, light: STAGE_COLORS.done.light }).toEqual({ dark: '#4bb64b', light: '#1a7f37' });
  });

  it('clears WCAG AA (>= 4.5:1) for the Scope label on its own fill in both themes', () => {
    // The dark pair also serves high-contrast themes (stagePalette.ts comment).
    expect(contrastRatio(STAGE_COLORS.scope.dark, STAGE_COLORS.scope.bg!.dark)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(STAGE_COLORS.scope.light, STAGE_COLORS.scope.bg!.light)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('stageColorClass', () => {
  it('maps a known stage to its class', () => {
    expect(stageColorClass('uat')).toBe('stg-uat');
  });

  it('falls back for an unknown or newly added stage rather than rendering uncolored', () => {
    expect(stageColorClass('quantum-review')).toBe(`stg-${STAGE_FALLBACK_KEY}`);
    expect(stageColorClass(null)).toBe(`stg-${STAGE_FALLBACK_KEY}`);
  });
});

describe('stagePaletteCss', () => {
  const css = stagePaletteCss();

  it('declares a token and a color class per stage', () => {
    for (const key of STAGE_KEYS) {
      expect(css).toContain(`--stage-${key}:${STAGE_COLORS[key].dark}`);
      expect(css).toContain(`.stg-${key}{color:var(--stage-${key})`);
    }
  });

  it('exposes each stage hue as --stg-color, so a knocked-out fill can reference it', () => {
    // A filled node overrides `color` for glyph contrast; fills must read the hue
    // from a handle the override cannot disturb, not from currentColor.
    for (const key of STAGE_KEYS) {
      expect(css).toContain(`.stg-${key}{color:var(--stage-${key});--stg-color:var(--stage-${key})`);
    }
  });

  it('declares the fallback token and class', () => {
    expect(css).toContain(`--stage-${STAGE_FALLBACK_KEY}:`);
    expect(css).toContain(`.stg-${STAGE_FALLBACK_KEY}{color:var(--stage-${STAGE_FALLBACK_KEY})`);
  });

  it('overrides every token for light themes', () => {
    expect(css).toContain('body.vscode-light');
    for (const key of STAGE_KEYS) {
      expect(css).toContain(`--stage-${key}:${STAGE_COLORS[key].light}`);
    }
  });

  it('emits the Scope background token per theme and a --stg-bg handle', () => {
    expect(css).toContain('--stage-scope-bg:#29343D');
    expect(css).toMatch(
      /\.stg-scope\{color:var\(--stage-scope\);--stg-color:var\(--stage-scope\);--stg-fg:var\(--stage-scope-fg\);--stg-bg:var\(--stage-scope-bg\)\}/,
    );
    const light = css.slice(css.indexOf('body.vscode-light'));
    expect(light).toContain('--stage-scope-bg:#EAEDF0');
  });

  it('gives no other stage a background token — Scope is the only approved pair', () => {
    for (const key of STAGE_KEYS) {
      if (key === 'scope') continue;
      expect(css).not.toContain(`--stage-${key}-bg:`);
      expect(css).not.toContain(`.stg-${key}{color:var(--stage-${key});--stg-color:var(--stage-${key});--stg-bg`);
    }
  });
});

describe('paletteCss', () => {
  it('carries the stage palette, so one injection point serves both views', () => {
    expect(paletteCss()).toContain(stagePaletteCss());
  });
});

/** Mix `fg` over `base` at `alpha` (what `color-mix(in srgb, fg alpha%, transparent)` paints over `base`). */
function over(fg: string, base: string, alpha: number): string {
  const ch = (hex: string): number[] => hex.slice(1).match(/.{2}/g)!.map((p) => parseInt(p, 16));
  const [f, b] = [ch(fg), ch(base)];
  const out = f.map((v, i) => Math.round(v * alpha + b[i]! * (1 - alpha)));
  return `#${out.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

// The surfaces a chip sits on: the panel and the row hover (docs/ui/prototypes/ref-chip.html).
const SURFACES = {
  dark: { panel: '#1f1f1f', hover: '#2a2d2e' },
  light: { panel: '#ffffff', hover: '#e8e8e8' },
} as const;
const MIN_TEXT_CONTRAST = 4.6;

describe('stage text tone (fg)', () => {
  for (const theme of ['dark', 'light'] as const) {
    for (const [name, fg, wash, alpha, key] of [
      ...STAGE_KEYS.map((k) => [k, STAGE_COLORS[k].fg[theme], STAGE_COLORS[k][theme], 0.2, k] as const),
      ['unknown', theme === 'dark' ? '#a6acb3' : '#525860', theme === 'dark' ? '#7d8590' : '#6e7681', 0.2, 'unknown'] as const,
      ['attention', ATTENTION_FG[theme], theme === 'dark' ? '#cca700' : '#bf8803', 0.3, 'attention'] as const,
    ]) {
      for (const surface of ['panel', 'hover'] as const) {
        it(`${name} reaches ${MIN_TEXT_CONTRAST}:1 on its wash over the ${surface} (${theme})`, () => {
          const base = SURFACES[theme][surface];
          const bgPair = key in STAGE_COLORS ? STAGE_COLORS[key as keyof typeof STAGE_COLORS].bg : undefined;
          const washed = bgPair ? bgPair[theme] : over(wash, base, alpha);
          expect(contrastRatio(fg, washed)).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
          // Bare text on the panel; on the hover the chip's own wash (above) is the ground.
          if (surface === 'panel') expect(contrastRatio(fg, base)).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
        });
      }
    }
  }

  it('injects --stage-<key>-fg per theme and --stg-fg per class', () => {
    const css = stagePaletteCss();
    expect(css).toContain('--stage-impl-fg:#a8a6f8;');
    expect(css).toMatch(/body\.vscode-light\{[^}]*--stage-impl-fg:#3a30e2;/);
    expect(css).toContain('.stg-impl{color:var(--stage-impl);--stg-color:var(--stage-impl);--stg-fg:var(--stage-impl-fg)}');
    expect(css).toContain('--stage-unknown-fg:#a6acb3;');
  });

  it('injects --k-attention-fg beside --k-attention', () => {
    const css = paletteCss();
    expect(css).toContain('--k-attention-fg:#f0c400;');
    expect(css).toContain('body.vscode-light{--k-attention-fg:#6f4f02}');
  });
});
