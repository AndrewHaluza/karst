import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  COLOUR_THRESHOLD,
  DRIFT_THRESHOLD,
  ELEMENT_TOLERANCE,
  PAGE_KNOWN_DRIFT,
  PAGE_SUBTLE_DRIFT,
  PAGE_TOLERANCE,
  effectiveAllowance,
  pageToleranceFor,
} from './screenshotTolerance.js';

const BASELINES = join(dirname(fileURLToPath(import.meta.url)), '__baselines__');

/**
 * T1367 (@ui:VISUAL-TOLERANCE): the allowance arithmetic and the calibration
 * it came from. The numbers are the measurements of
 * `tests/visual/calibration/tolerance.calibrate.ts`, run in the pinned
 * Playwright image on 2026-11-26 (dark, light, hc; every noise repeat at 0).
 * Re-run `npm run -s test:visual:calibrate:docker` to reproduce them.
 */

/** Noise floor: the same page rendered twice, 45 pairs across 9 variants x 3 themes x 3 repeats. */
const NOISE_PX = [0];

/** Element captures: a single-digit label change, and a 1-2 word label change. */
const ELEMENT_DIGIT_PX = [5, 6, 7, 8, 10];
const ELEMENT_WORDS_PX = [25, 41, 71, 85, 119, 155, 201, 217, 474];

/** Page captures: the same two perturbations (`dashboard/populated`, `sidebar/populated`). */
const PAGE_DIGIT_PX = [12, 14, 19, 23, 23, 33];
const PAGE_WORDS_PX = [27, 41, 60, 60, 78, 114];

/** (a) A border/text tint shifted by 64/255 per channel: the smallest step the comparator registers at all. */
const ELEMENT_TINT_PX = [52, 103, 126, 320, 345, 535, 546, 1720];
const PAGE_TINT_PX = [1661, 26837, 28713];

/**
 * (a) The same tints shifted by only 16/255, counted at `COLOUR_THRESHOLD`
 * (0.05). At the old 0.2 every one of these counted 0 px, and so did 0.1.
 * Label counts only grow as the threshold drops, so the 0.2 label rows above
 * are lower bounds at 0.05.
 */
const ELEMENT_SUBTLE_TINT_PX = [48, 110, 120, 243, 394, 531, 541, 551, 1720];
const PAGE_SUBTLE_TINT_PX = [1661, 1661, 1661, 8408, 26827, 28751];

/** The areas the allocation is judged at: the smallest and the largest capture of each mode (registry scan). */
const ELEMENT_AREA_SMALLEST = 26_100;
const ELEMENT_AREA_LARGEST = 883_300;
const PAGE_AREA_SMALLEST = 93_600;
const PAGE_AREA_LARGEST = 7_530_240;

/** The old global page allowance: the cap a ledger entry may never exceed. */
const OLD_PAGE_ALLOWANCE_PX = 400;

/** PAGE_KNOWN_DRIFT is a ratchet: lower this count when an entry goes, never raise it. */
const KNOWN_DRIFT_ENTRIES = 55;

/** PAGE_SUBTLE_DRIFT is a ratchet too: lower this count when a key goes, never raise it. */
const SUBTLE_DRIFT_ENTRIES = 16;

describe('effectiveAllowance: the smaller of the two limits (@ui:VISUAL-TOLERANCE)', () => {
  it('takes the smaller limit when both are set', () => {
    // playwright-core/lib/coreBundle.js compareImages: Math.min(maxDiffPixels, width*height*maxDiffPixelRatio).
    expect(effectiveAllowance(1_000_000, { threshold: 0.2, maxDiffPixels: 400, maxDiffPixelRatio: 0.002 })).toBe(400);
    expect(effectiveAllowance(100_000, { threshold: 0.2, maxDiffPixels: 400, maxDiffPixelRatio: 0.002 })).toBe(200);
  });

  it('takes the one limit that is set', () => {
    expect(effectiveAllowance(500_000, { threshold: 0.2, maxDiffPixels: 3 })).toBe(3);
    expect(effectiveAllowance(500_000, { threshold: 0.2, maxDiffPixelRatio: 0.002 })).toBe(1000);
  });

  it('allows nothing when no limit is set', () => {
    expect(effectiveAllowance(500_000, { threshold: 0.2 })).toBe(0);
  });
});

describe('the page-mode tolerance (@ui:VISUAL-TOLERANCE)', () => {
  it('compares colours at the threshold that registers a 16/255 tint shift', () => {
    expect(PAGE_TOLERANCE.threshold).toBe(COLOUR_THRESHOLD);
    expect(COLOUR_THRESHOLD).toBeLessThan(DRIFT_THRESHOLD);
  });

  it('allows a flat count at every page area, with no ratio', () => {
    expect(PAGE_TOLERANCE.maxDiffPixelRatio).toBeUndefined();
    expect(effectiveAllowance(PAGE_AREA_SMALLEST, PAGE_TOLERANCE)).toBe(PAGE_TOLERANCE.maxDiffPixels);
    expect(effectiveAllowance(PAGE_AREA_LARGEST, PAGE_TOLERANCE)).toBe(PAGE_TOLERANCE.maxDiffPixels);
  });

  it('catches every measured label change and tint shift', () => {
    for (const diffPixels of [...PAGE_DIGIT_PX, ...PAGE_WORDS_PX, ...PAGE_TINT_PX, ...PAGE_SUBTLE_TINT_PX]) {
      expect(diffPixels).toBeGreaterThan(effectiveAllowance(PAGE_AREA_LARGEST, PAGE_TOLERANCE));
    }
  });

  it('sits above the noise floor', () => {
    for (const diffPixels of NOISE_PX) {
      expect(effectiveAllowance(PAGE_AREA_LARGEST, PAGE_TOLERANCE)).toBeGreaterThan(diffPixels);
    }
  });
});

describe('the known drift ledger (@ui:VISUAL-TOLERANCE)', () => {
  const entries = Object.entries(PAGE_KNOWN_DRIFT);

  it('only shrinks', () => {
    expect(entries).toHaveLength(KNOWN_DRIFT_ENTRIES);
  });

  it('names only recorded baselines, so a re-recorded or removed shot leaves no stale entry', () => {
    const missing = entries.map(([key]) => key).filter((key) => !existsSync(join(BASELINES, key)));
    expect(missing).toEqual([]);
  });

  it('holds only drift above the page tolerance and within the old allowance', () => {
    for (const [key, drift] of entries) {
      expect(drift, key).toBeGreaterThan(PAGE_TOLERANCE.maxDiffPixels ?? 0);
      expect(drift, key).toBeLessThanOrEqual(OLD_PAGE_ALLOWANCE_PX);
    }
  });

  it('gives a ledger shot exactly its own drift, and every other shot the page tolerance', () => {
    // A ledger count was measured at DRIFT_THRESHOLD, so the shot keeps that threshold with its count.
    expect(pageToleranceFor('hc', 'sidebar--stage-chip-300.png')).toEqual({ threshold: DRIFT_THRESHOLD, maxDiffPixels: 389 });
    for (const key of Object.keys(PAGE_KNOWN_DRIFT)) {
      const [project, baseline] = key.split('/') as [string, string];
      expect(pageToleranceFor(project, baseline).threshold, key).toBe(DRIFT_THRESHOLD);
    }
    expect(pageToleranceFor('dark', 'status-primitives.png').maxDiffPixels).toBe(234);
    expect(pageToleranceFor('dark', 'dashboard-running.png')).toBe(PAGE_TOLERANCE);
    // The key is the project AND the file: the dark drift of a shot does not leak into its light twin.
    expect(pageToleranceFor('dark', 'agents-compare.png')).not.toBe(PAGE_TOLERANCE);
    expect(pageToleranceFor('light', 'agents-compare.png')).toBe(PAGE_TOLERANCE);
  });
});

describe('the subtle drift list (@ui:VISUAL-TOLERANCE)', () => {
  const keys = [...PAGE_SUBTLE_DRIFT];

  it('only shrinks', () => {
    expect(keys).toHaveLength(SUBTLE_DRIFT_ENTRIES);
  });

  it('names only recorded baselines, and none that the known drift ledger already holds', () => {
    expect(keys.filter((key) => !existsSync(join(BASELINES, key)))).toEqual([]);
    expect(keys.filter((key) => key in PAGE_KNOWN_DRIFT)).toEqual([]);
  });

  it('gives a listed shot the page allowance at the old colour threshold', () => {
    for (const key of keys) {
      const [project, baseline] = key.split('/') as [string, string];
      expect(pageToleranceFor(project, baseline), key).toEqual({ ...PAGE_TOLERANCE, threshold: DRIFT_THRESHOLD });
    }
    // A shot in neither list keeps the page tolerance at COLOUR_THRESHOLD.
    expect(pageToleranceFor('dark', 'dashboard-running.png')).toBe(PAGE_TOLERANCE);
  });
});

describe('the element-mode tolerance (@ui:VISUAL-TOLERANCE)', () => {
  it('compares colours at the threshold that registers a 16/255 tint shift', () => {
    expect(ELEMENT_TOLERANCE.threshold).toBe(COLOUR_THRESHOLD);
  });

  it('allows a flat count at every element area, with no ratio', () => {
    // No ratio on purpose: a ratio would allow 1,766 px on the 883,300 px Inside region, which is exactly the
    // silent pass this ticket removes.
    expect(ELEMENT_TOLERANCE.maxDiffPixelRatio).toBeUndefined();
    expect(effectiveAllowance(ELEMENT_AREA_SMALLEST, ELEMENT_TOLERANCE)).toBe(ELEMENT_TOLERANCE.maxDiffPixels);
    expect(effectiveAllowance(ELEMENT_AREA_LARGEST, ELEMENT_TOLERANCE)).toBe(ELEMENT_TOLERANCE.maxDiffPixels);
  });

  it('catches every measured label change and tint shift', () => {
    for (const diffPixels of [...ELEMENT_DIGIT_PX, ...ELEMENT_WORDS_PX, ...ELEMENT_TINT_PX, ...ELEMENT_SUBTLE_TINT_PX]) {
      expect(diffPixels).toBeGreaterThan(effectiveAllowance(ELEMENT_AREA_LARGEST, ELEMENT_TOLERANCE));
    }
  });

  it('sits above the noise floor', () => {
    for (const diffPixels of NOISE_PX) {
      expect(effectiveAllowance(ELEMENT_AREA_LARGEST, ELEMENT_TOLERANCE)).toBeGreaterThan(diffPixels);
    }
  });

  it('stays below the smallest measured regression, with margin', () => {
    const smallest = Math.min(...ELEMENT_DIGIT_PX, ...ELEMENT_WORDS_PX, ...ELEMENT_TINT_PX);
    const allowance = effectiveAllowance(ELEMENT_AREA_LARGEST, ELEMENT_TOLERANCE);
    expect(allowance).toBeLessThan(smallest);
    // A margin of at least a third of the smallest count: 3 px against 5 px.
    expect(allowance).toBeLessThanOrEqual(Math.floor((smallest * 2) / 3));
  });
});
