/**
 * T1367 (@ui:VISUAL-TOLERANCE): the screenshot tolerance of each capture mode,
 * and the rule that turns it into a pixel allowance.
 *
 * One global tolerance served two very different shots. With both limits set,
 * `toHaveScreenshot` allows the SMALLER of `maxDiffPixels` and
 * `area * maxDiffPixelRatio` (`compareImages` in
 * `node_modules/playwright-core/lib/coreBundle.js`):
 *
 *  - a full page (93,600-7,530,240 px) was allowed 400 px (`maxDiffPixels`),
 *  - a T1364 element capture (26,100-883,300 px) was allowed the ratio: 52-400 px,
 *
 * so a one-digit label change (5-33 px measured) passed in both modes. The
 * measurement is `tests/visual/calibration/tolerance.calibrate.ts`; the result
 * and the rationale are `docs/ui/VISUAL-COVERAGE.md` `@ui:VISUAL-TOLERANCE`.
 *
 * `threshold` stays at 0.2 in both modes: it is the comparator's own colour
 * threshold, and lowering it for anti-aliasing reasons would make every glyph
 * edge a difference (a tint shifted by 16/255 changed 0 px, by 64/255 changed
 * hundreds: that is the threshold, not the allowance).
 */

/** The tolerance a screenshot is compared with (`expect.toHaveScreenshot` options). */
export interface ScreenshotTolerance {
  /** Colour distance above which a pixel counts as different (pixelmatch's threshold). */
  readonly threshold: number;
  /** Largest number of differing pixels allowed. */
  readonly maxDiffPixels?: number;
  /** Largest fraction of differing pixels allowed (binds only where it is smaller than `maxDiffPixels`). */
  readonly maxDiffPixelRatio?: number;
}

/**
 * Full-page captures. UNCHANGED by T1367, on purpose: the same sweep at
 * `maxDiffPixels: 0` shows 60 existing full-page baselines differing from their
 * PNG, the worst by 389 px (`sidebar/stage-chip-300`, a now-truncated
 * "accepted"). Re-recording them is out of scope (`@ui:RUNNING-SWEEP`), so the
 * allowance must stay above 389; 400 is that value and it catches a tint shift
 * (1,661-28,713 px measured). A 12-114 px label change on a page still passes:
 * that gap is a named limitation (`@ui:LIMITATIONS`).
 */
export const PAGE_TOLERANCE: ScreenshotTolerance = {
  threshold: 0.2,
  maxDiffPixelRatio: 0.002,
  maxDiffPixels: 400,
};

/**
 * Element captures (`page.locator(target)`, T1364). Flat 3 px, no ratio: every
 * measured element regression costs at least 5 px (a single digit in
 * "12.2k tok"), and every one of the 191 recorded element baselines renders
 * pixel-identically today (0 px), as do all 45 noise pairs. A ratio here would
 * allow 1,766 px on the 883,300 px Inside region, which is the silent pass this
 * ticket removes.
 */
export const ELEMENT_TOLERANCE: ScreenshotTolerance = {
  threshold: 0.2,
  maxDiffPixels: 3,
};

/**
 * The allowance a differing-pixel count is compared with: the smaller of
 * `maxDiffPixels` and `area * maxDiffPixelRatio`, and the one that is set when
 * only one is. A comparison fails when the count is GREATER than this value
 * (`compareImages`: `count > maxDiffPixels`), so a count equal to it passes.
 */
export function effectiveAllowance(area: number, tolerance: ScreenshotTolerance): number {
  const byPixels = tolerance.maxDiffPixels;
  const byRatio = tolerance.maxDiffPixelRatio === undefined ? undefined : area * tolerance.maxDiffPixelRatio;
  if (byPixels !== undefined && byRatio !== undefined) return Math.min(byPixels, byRatio);
  return byPixels ?? byRatio ?? 0;
}
