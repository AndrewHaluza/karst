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
 * Full-page and viewport captures. A flat 3 px, no ratio, the same as the
 * element mode: the smallest measured page regression is 12 px (a single digit
 * on `dashboard/populated`), and every full-page shot outside
 * `PAGE_KNOWN_DRIFT` rendered pixel-identically to its PNG (0 px) in two full
 * sweeps and five popover-family repeats. The old pair
 * (400 px, ratio 0.002) let a 12-114 px label change on a page pass.
 */
export const PAGE_TOLERANCE: ScreenshotTolerance = {
  threshold: 0.2,
  maxDiffPixels: 3,
};

/**
 * Known drift ledger (T1367, `@ui:VISUAL-TOLERANCE`): the full-page shots whose
 * fresh render already differs from the recorded PNG by more than
 * `PAGE_TOLERANCE`, keyed `<project>/<baseline>`, each with its measured count
 * (the full sweep at `maxDiffPixels: 0` in the pinned image, 2026-11-26). Each
 * entry allows exactly its own drift, so a new change on that page still fails.
 * Re-recording is out of scope (`@ui:RUNNING-SWEEP`); `ui:VISUAL-DEFECTS` names
 * the causes. A ratchet: remove an entry when its baseline is re-recorded, and
 * never add one (`screenshotTolerance.test.ts` pins the count).
 */
export const PAGE_KNOWN_DRIFT: Readonly<Record<string, number>> = Object.freeze({
  'dark/dashboard--baseline-overlay-1.png': 4,
  'dark/dashboard--baseline-overlay-12.png': 4,
  'dark/dashboard--baseline-overlay-48.png': 4,
  'dark/dashboard--baseline-overlay-mixed.png': 6,
  'dark/dashboard--baseline-overlay-new-file.png': 32,
  'dark/dashboard--baseline-overlay-prior-rejected.png': 6,
  'dark/dashboard--baseline-overlay-themes-5.png': 4,
  // Intermittent: the review menu popover renders one of two fixed states,
  // 0 px or exactly 312 px (5 repeats: open-wide flipped 3 times, retry-only once).
  'dark/dashboard--inside-review-menu-open-wide.png': 312,
  'dark/dashboard--inside-review-menu-retry-only.png': 312,
  'dark/dashboard--graph-blocked-config.png': 30,
  'dark/dashboard--graph-blocked-explicit.png': 30,
  'dark/dashboard--graph-blocked-replans-exhausted.png': 30,
  'dark/settings--accounts-long-name.png': 4,
  'dark/settings--accounts-not-signed-in.png': 94,
  'dark/settings--accounts-sbx-token.png': 69,
  'dark/settings--discard-undo.png': 229,
  'dark/agents-profile.png': 47,
  'dark/settings--repositories-long-path.png': 96,
  'dark/settings--roles-mid.png': 47,
  'dark/settings--roles-no-presets.png': 47,
  'dark/agents-compare.png': 47,
  'dark/settings--ticketing-clickup.png': 47,
  'dark/settings--ticketing-manual.png': 47,
  'dark/sidebar--error.png': 83,
  'dark/sidebar--filtered-300.png': 16,
  'dark/sidebar--planning-deps.png': 256,
  'dark/sidebar--priority.png': 85,
  'dark/sidebar--stage-chip-300.png': 256,
  'dark/sidebar--stage-chip-320.png': 256,
  'dark/sidebar--stage-chip-460.png': 256,
  'dark/status-primitives.png': 234,
  'dark-grayscale/status-primitives.png': 34,
  'dark-reduced-motion/status-primitives.png': 234,
  'hc/settings--accounts-sbx-token.png': 69,
  'hc/agents-profile.png': 36,
  'hc/settings--route-agents-agents-profiles.png': 71,
  'hc/settings--route-agents-agents-profiles-builtin-3AuatTester.png': 71,
  'hc/settings--route-agents-agents-profiles-tdd-implementer.png': 107,
  'hc/agents-roles.png': 252,
  'hc/settings--route-agents-agents-roles-uatTester.png': 323,
  'hc/settings--route-approaches.png': 36,
  'hc/settings--route-autopilot.png': 71,
  'hc/settings--route-git.png': 71,
  'hc/settings--route-quality.png': 71,
  'hc/settings--route-services.png': 72,
  'hc/settings--route-ticketing.png': 71,
  'hc/sidebar--stage-chip-300.png': 389,
  'hc/sidebar--stage-chip-320.png': 389,
  'hc/sidebar--stage-chip-460.png': 389,
  'light/settings--accounts-sbx-token.png': 69,
  'light/sidebar--planning-artifacts-300.png': 43,
  'light/sidebar--planning-artifacts-320.png': 43,
  'light/sidebar--planning-artifacts-460.png': 43,
  'light/sidebar--stage-chip-300.png': 318,
  'light/sidebar--stage-chip-320.png': 318,
  'light/sidebar--stage-chip-460.png': 318,
});

/**
 * The page-mode tolerance of one shot: its `PAGE_KNOWN_DRIFT` allowance, or
 * `PAGE_TOLERANCE`. `project` is the Playwright theme project and `baseline`
 * the PNG file name.
 */
export function pageToleranceFor(project: string, baseline: string): ScreenshotTolerance {
  const drift = PAGE_KNOWN_DRIFT[`${project}/${baseline}`];
  return drift === undefined ? PAGE_TOLERANCE : { ...PAGE_TOLERANCE, maxDiffPixels: drift };
}

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
