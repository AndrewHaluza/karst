import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { INSIDE_EXTRA_WIDTHS, LAYOUT_WIDTHS, NARROW_MAX, TIGHT_MAX, WIDE_MIN, layoutWidthsFor, tierFor } from './layoutBreakpoints.js';

/**
 * CSS files whose `@media` widths are pinned to the tiers. Empty today: the
 * existing settings CSS still uses 1024/768/800/700px. The Agents page CSS is
 * aligned; the other files migrate in later tickets.
 */
const BREAKPOINT_PINNED_FILES: readonly string[] = [
  'src/ui/settings/agents.webview.css',
  'src/ui/resources/servers.webview.css',
  'src/ui/dashboard/app/InsideResponsive.css',
];

/** `(min-width: 1000px)` / `(max-width: 699px)` boundaries a pinned file may use. */
const ALLOWED_PX = new Set([WIDE_MIN, WIDE_MIN - 1, NARROW_MAX, NARROW_MAX + 1, TIGHT_MAX, TIGHT_MAX + 1]);
const MEDIA_WIDTH = /@(?:media|container)[^{]*?\(\s*(?:min|max)-width\s*:\s*(\d+(?:\.\d+)?)px\s*\)/g;

function mediaWidths(css: string): number[] {
  return Array.from(css.matchAll(MEDIA_WIDTH), (m) => Number(m[1]));
}

describe('tierFor', () => {
  it.each([
    [1280, 'wide'],
    [1000, 'wide'],
    [999, 'mid'],
    [900, 'mid'],
    [700, 'mid'],
    [699, 'narrow'],
    [480, 'narrow'],
    [400, 'narrow'],
    [399, 'tight'],
    [320, 'tight'],
  ] as const)('%ipx is %s', (width, tier) => {
    expect(tierFor(width)).toBe(tier);
  });

  it('opens both sides of each boundary', () => {
    const tiers = new Set(LAYOUT_WIDTHS.map(tierFor));
    expect(tiers).toEqual(new Set(['wide', 'mid', 'narrow']));
    expect(LAYOUT_WIDTHS).toContain(NARROW_MAX);
    expect(LAYOUT_WIDTHS).toContain(NARROW_MAX + 1);
  });
});

describe('layoutWidthsFor', () => {
  it('keeps the 480 floor for every view but the Inside dashboard targets', () => {
    expect(layoutWidthsFor('settings', 'agents')).toEqual(LAYOUT_WIDTHS);
    expect(layoutWidthsFor('dashboard', 'drill-runtime-narrow')).toEqual(LAYOUT_WIDTHS);
    expect(layoutWidthsFor('usage', 'inside-impl-x')).toEqual(LAYOUT_WIDTHS);
  });

  it('adds 400, 399 and 320 on inside-* dashboard targets, opening both sides of the tight boundary', () => {
    const widths = layoutWidthsFor('dashboard', 'inside-ship-deliver-auto-failed');
    expect(widths).toEqual([...LAYOUT_WIDTHS, ...INSIDE_EXTRA_WIDTHS]);
    expect(widths).toEqual(expect.arrayContaining([400, 399, 320]));
    expect(new Set(widths.map(tierFor))).toEqual(new Set(['wide', 'mid', 'narrow', 'tight']));
    expect(new Set(widths).size).toBe(widths.length);
  });

  it('matches the inside- prefix only, not a name that merely contains it', () => {
    expect(layoutWidthsFor('dashboard', 'outside-inside-x')).toEqual(LAYOUT_WIDTHS);
  });
});

describe('mediaWidths', () => {
  it('reads min and max px widths', () => {
    expect(mediaWidths('@media (max-width: 699px) { a{} } @media (min-width:1000px){b{}}')).toEqual([699, 1000]);
  });
  it('ignores em queries and non-width media', () => {
    expect(mediaWidths('@media (min-width: 40em) {} @media (prefers-reduced-motion: reduce) {}')).toEqual([]);
  });
});

describe('BREAKPOINT_PINNED_FILES', () => {
  it('only uses the tier boundaries in @media widths', () => {
    for (const file of BREAKPOINT_PINNED_FILES) {
      const css = readFileSync(join(process.cwd(), file), 'utf8');
      const bad = mediaWidths(css).filter((w) => !ALLOWED_PX.has(w));
      expect(bad, `${file}: @media widths outside ${[...ALLOWED_PX].join('/')}px`).toEqual([]);
    }
  });
});
