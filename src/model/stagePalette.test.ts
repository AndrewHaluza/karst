import { describe, it, expect } from 'vitest';
import { STAGE_KEYS } from './types.js';
import {
  STAGE_COLORS,
  STAGE_FALLBACK_KEY,
  stageColorClass,
  stagePaletteCss,
} from './stagePalette.js';
import { PALETTE_TOKENS, paletteCss } from './palette.js';

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
      expect(css).toContain(`.stg-${key}{color:var(--stage-${key})}`);
    }
  });

  it('declares the fallback token and class', () => {
    expect(css).toContain(`--stage-${STAGE_FALLBACK_KEY}:`);
    expect(css).toContain(`.stg-${STAGE_FALLBACK_KEY}{color:var(--stage-${STAGE_FALLBACK_KEY})}`);
  });

  it('overrides every token for light themes', () => {
    expect(css).toContain('body.vscode-light');
    for (const key of STAGE_KEYS) {
      expect(css).toContain(`--stage-${key}:${STAGE_COLORS[key].light}`);
    }
  });
});

describe('paletteCss', () => {
  it('carries the stage palette, so one injection point serves both views', () => {
    expect(paletteCss()).toContain(stagePaletteCss());
  });
});
