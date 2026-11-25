import { describe, expect, it } from 'vitest';
import { ELEMENT_TOLERANCE, PAGE_TOLERANCE, effectiveAllowance } from './screenshotTolerance.js';

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

/** The areas the allocation is judged at: the smallest and the largest capture of each mode (registry scan). */
const ELEMENT_AREA_SMALLEST = 26_100;
const ELEMENT_AREA_LARGEST = 883_300;
const PAGE_AREA_SMALLEST = 93_600;
const PAGE_AREA_LARGEST = 7_530_240;

/** The worst full-page difference against an existing baseline, measured by the same sweep at `maxDiffPixels: 0`. */
const WORST_PAGE_DRIFT_PX = 389;

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
  it('binds at maxDiffPixels above 200,000 px and at the ratio below it', () => {
    expect(effectiveAllowance(PAGE_AREA_LARGEST, PAGE_TOLERANCE)).toBe(400);
    expect(effectiveAllowance(PAGE_AREA_SMALLEST, PAGE_TOLERANCE)).toBeCloseTo(187.2, 5);
  });

  it('stays above the worst existing full-page difference, so no recorded baseline turns red', () => {
    // The sweep at maxDiffPixels: 0 fails 48 existing full-page screenshots (60 tests, 0 element captures); the worst
    // is sidebar/stage-chip-300 at 389 px (the "accepted" chip now truncates). Re-recording is out of scope
    // (@ui:RUNNING-SWEEP), so the page allowance must stay above that difference.
    const area = 300 * 720; // the drifted sidebar page: the ratio would allow 432, so maxDiffPixels binds at 400.
    expect(effectiveAllowance(area, PAGE_TOLERANCE)).toBeGreaterThan(WORST_PAGE_DRIFT_PX);
  });

  it('catches the measured tint shift', () => {
    for (const diffPixels of PAGE_TINT_PX) {
      expect(diffPixels).toBeGreaterThan(effectiveAllowance(PAGE_AREA_LARGEST, PAGE_TOLERANCE));
    }
  });

  it('cannot catch a small label change: the named limitation the drift forces', () => {
    // Nothing measured here fits under 400 px on a full page: a digit costs 12-33 px, a word 27-114 px. A page
    // allowance low enough to catch them (< 12) would turn the 389 px baseline red, and this ticket may not
    // re-record it. @ui:VISUAL-TOLERANCE records the gap as @ui:LIMITATIONS.
    for (const diffPixels of [...PAGE_DIGIT_PX, ...PAGE_WORDS_PX]) {
      expect(diffPixels).toBeLessThanOrEqual(effectiveAllowance(PAGE_AREA_LARGEST, PAGE_TOLERANCE));
    }
  });
});

describe('the element-mode tolerance (@ui:VISUAL-TOLERANCE)', () => {
  it('allows a flat count at every element area, with no ratio', () => {
    // No ratio on purpose: a ratio would allow 1,766 px on the 883,300 px Inside region, which is exactly the
    // silent pass this ticket removes.
    expect(ELEMENT_TOLERANCE.maxDiffPixelRatio).toBeUndefined();
    expect(effectiveAllowance(ELEMENT_AREA_SMALLEST, ELEMENT_TOLERANCE)).toBe(ELEMENT_TOLERANCE.maxDiffPixels);
    expect(effectiveAllowance(ELEMENT_AREA_LARGEST, ELEMENT_TOLERANCE)).toBe(ELEMENT_TOLERANCE.maxDiffPixels);
  });

  it('catches every measured label change and tint shift', () => {
    for (const diffPixels of [...ELEMENT_DIGIT_PX, ...ELEMENT_WORDS_PX, ...ELEMENT_TINT_PX]) {
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
