/**
 * T1367 (@ui:VISUAL-TOLERANCE): the perturbation probe that measures how many
 * pixels a small regression costs in each capture mode.
 *
 * It renders a variant exactly as `pages.visual.ts` does (same fixture page,
 * same viewport, same masks), takes an unperturbed screenshot, takes a second
 * screenshot of the same variant with ONE deliberate change, and counts the
 * differing pixels with Playwright's own comparator at the configured
 * `threshold`. The count is what `toHaveScreenshot` compares with
 * `maxDiffPixels` / `maxDiffPixelRatio` (the smaller of the two wins, see
 * `effectiveAllowance`).
 *
 * Why a probe and not a guess: the allowance in `playwright.config.ts` is one
 * pair of numbers, but an element capture and a full-page capture have very
 * different areas, so the same pair binds on a different limit in each mode.
 * The probe measures the smallest regression the sweep must catch (a
 * single-digit label change) and the noise floor (the same page rendered
 * twice), so the tolerance can be set inside that gap.
 *
 * The file is NOT a `*.visual.ts` spec: `playwright.config.ts` matches
 * `**\/*.visual.ts`, so the sweep and CI never collect it. It runs through
 * `playwright.calibration.config.ts` (`npm run test:visual:calibrate:docker`).
 *
 * Output: `tests/visual/.report/calibration/tolerance-<project>.json` and
 * `-<project>.md` (gitignored), plus the same table on stdout.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { test } from '../fixtures.js';
import { effectiveAllowance, PAGE_TOLERANCE, type ScreenshotTolerance } from '../screenshotTolerance.js';
import { screenshotFullPage, VARIANTS, type Variant, type ViewId } from '../variants.js';

/** The comparator threshold the sweep configures; a pixel counts as different above it. */
const THRESHOLD = PAGE_TOLERANCE.threshold;

/** The global tolerance before this ticket, used for the "old" verdict column. */
const OLD_TOLERANCE: ScreenshotTolerance = { threshold: 0.2, maxDiffPixelRatio: 0.002, maxDiffPixels: 400 };

/**
 * Every pair is also counted at these comparator thresholds, so one run shows
 * where a colour shift starts to register and whether the noise floor stays 0.
 */
const THRESHOLD_SWEEP = [0.2, 0.1, 0.05, 0.03, 0] as const;

/** A repeat of the SAME page with no perturbation: the largest count is the noise floor. */
const NOISE_REPEATS = 3;

/**
 * Per-channel steps for the colour-token perturbation, on a 0-255 channel.
 * 16 is the step the ticket names as "subtle" (about 6%); 8 shows the margin
 * below it; 64 crossed the old comparator threshold (0.2) on this UI.
 */
const COLOUR_STEPS = [8, 16, 64] as const;

/** The elements `pages.visual.ts` masks before a shot (a live clock or elapsed-time readout). */
const TIME_MASKS = ['[data-karst-clock]', '.k-clock', '[data-elapsed]'].join(', ');

/** One measured variant: a capture mode, a colour token, and the two label perturbations. */
interface CalibrationCase {
  /** `view/variant`, the same key the sweep prints. */
  readonly id: string;
  readonly view: ViewId;
  readonly variant: string;
  /** The CSS custom property the colour perturbation shifts (a border, or the dim/disabled text tint). */
  readonly colourToken: string;
  /** (b) a 1-2 word label change inside the captured region. */
  readonly words: { readonly from: string; readonly to: string };
  /** (b) a single-digit change in a visible label inside the captured region; absent when the region shows no digit. */
  readonly digit?: { readonly from: string; readonly to: string };
}

/**
 * Two full-page variants and six element captures. The element set covers each
 * capture family (`@ui:VISUAL-VARIANTS`) at the smallest and the largest area
 * the registry records: `[data-region="runtime"]` 26,100 px,
 * `[data-region="servers"]` 63,984 px, `[data-region="prs"]` 226,368 px,
 * `#inside` 883,300 px. All of them are resting pages with no click step, so
 * the probe measures the page the sweep records.
 */
const CASES: readonly CalibrationCase[] = [
  {
    id: 'dashboard/populated',
    view: 'dashboard',
    variant: 'populated',
    colourToken: '--k-border',
    words: { from: 'Agent default', to: 'Agent preset' },
    digit: { from: 'T942017', to: 'T942018' },
  },
  {
    id: 'sidebar/populated',
    view: 'sidebar',
    variant: 'populated',
    colourToken: '--k-border',
    words: { from: 'Current', to: 'Present' },
    digit: { from: 'P90', to: 'P91' },
  },
  {
    id: 'dashboard/panel-srv-one-wide',
    view: 'dashboard',
    variant: 'panel-srv-one-wide',
    colourToken: '--k-border',
    words: { from: 'all running', to: 'all halted' },
    digit: { from: '5173', to: '5174' },
  },
  {
    id: 'dashboard/panel-pr-autofix-parked-wide',
    view: 'dashboard',
    variant: 'panel-pr-autofix-parked-wide',
    colourToken: '--k-text-dim',
    words: { from: 'Ready to merge', to: 'Ready to land' },
    digit: { from: '#421', to: '#422' },
  },
  {
    id: 'dashboard/runtime-docker-narrow',
    view: 'dashboard',
    variant: 'runtime-docker-narrow',
    colourToken: '--k-text-dim',
    words: { from: 'Agent default', to: 'Agent preset' },
  },
  {
    id: 'dashboard/runtime-carry-wide',
    view: 'dashboard',
    variant: 'runtime-carry-wide',
    colourToken: '--k-text-dim',
    words: { from: 'Sync', to: 'Push' },
  },
  {
    id: 'dashboard/inside-review-multi-repo-filter-tight',
    view: 'dashboard',
    variant: 'inside-review-multi-repo-filter-tight',
    colourToken: '--k-text-dim',
    words: { from: 'reviewer', to: 'checker' },
    digit: { from: '3 blocking', to: '4 blocking' },
  },
  {
    id: 'dashboard/inside-impl-bounded-timeline',
    view: 'dashboard',
    variant: 'inside-impl-bounded-timeline',
    colourToken: '--k-text-dim',
    words: { from: 'done', to: 'pass' },
    digit: { from: '12.4k tok', to: '12.5k tok' },
  },
  {
    // The one element capture the registry records in all three themes, so the
    // light and hc projects measure an element diff too.
    id: 'dashboard/inside-impl-graph-running',
    view: 'dashboard',
    variant: 'inside-impl-graph-running',
    colourToken: '--k-text-dim',
    words: { from: 'Graph view', to: 'Graph map' },
    digit: { from: '12.2k tok', to: '12.3k tok' },
  },
];

/** Playwright's image comparator: `(actual, expected, options) => { errorMessage } | null`. */
interface ImageComparator {
  (
    actual: Buffer,
    expected: Buffer,
    options: { threshold?: number; maxDiffPixels?: number; maxDiffPixelRatio?: number },
  ): { errorMessage: string; diff?: Buffer } | null;
}

/**
 * The comparator `toHaveScreenshot` uses, taken from `playwright-core`'s own
 * bundle (`utils.getComparator('image/png')`). Calling it directly returns the
 * pixel count without a snapshot file, and it is the SAME code the matcher
 * runs, so the measurement and the gate cannot disagree.
 */
function imageComparator(): ImageComparator {
  const require = createRequire(join(process.cwd(), 'package.json'));
  const utils = (require('playwright-core/lib/coreBundle') as { utils?: Record<string, unknown> }).utils;
  const factory = utils?.['getComparator'];
  if (typeof factory !== 'function') {
    throw new Error('playwright-core no longer exports utils.getComparator: re-check the comparator seam in tests/visual/calibration/tolerance.calibrate.ts');
  }
  return (factory as (mimeType: string) => ImageComparator)('image/png');
}

const COMPARATOR = imageComparator();

/** The number of differing pixels between two PNG buffers at `threshold` (0 when they match). */
export function countDifferingPixels(actual: Buffer, expected: Buffer, threshold: number = THRESHOLD): number {
  const result = COMPARATOR(actual, expected, { threshold, maxDiffPixels: 0 });
  if (result === null) return 0;
  const match = /(\d+) pixels \(ratio/.exec(result.errorMessage);
  if (!match) throw new Error(`could not read a pixel count from "${result.errorMessage}"`);
  return Number(match[1]);
}

/** The PNG's pixel area, read from the IHDR chunk (bytes 16-23), without decoding the image. */
export function pngArea(png: Buffer): { width: number; height: number; area: number } {
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  return { width, height, area: width * height };
}

/**
 * `#rrggbb`, `rgb(...)` or `rgba(...)` with each colour channel moved by
 * `delta`: up when the channel has room, down when it is within `delta` of 255.
 * A clamped shift (white + 64) changes nothing and read as a silent pass. The
 * alpha is unchanged.
 */
export function shiftColour(value: string, delta: number): string {
  const clamp = (channel: number): number => (channel + delta <= 255 ? channel + delta : Math.max(0, channel - delta));
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex !== null) {
    const packed = parseInt(hex[1]!, 16);
    return `rgb(${clamp((packed >> 16) & 255)}, ${clamp((packed >> 8) & 255)}, ${clamp(packed & 255)})`;
  }
  const functional = /^rgba?\(([^)]+)\)$/.exec(value);
  if (functional === null) throw new Error(`unsupported CSS colour "${value}"`);
  const parts = functional[1]!.split(',').map((part) => Number(part.trim()));
  if (parts.length < 3 || parts.some((part) => Number.isNaN(part))) throw new Error(`unsupported CSS colour "${value}"`);
  const [red, green, blue] = parts as [number, number, number];
  const alpha = parts.length > 3 ? parts[3]! : 1;
  return `rgba(${clamp(red)}, ${clamp(green)}, ${clamp(blue)}, ${alpha})`;
}

/**
 * The allowance `toHaveScreenshot` compares a count with: the SMALLER of
 * `maxDiffPixels` and `area * maxDiffPixelRatio`
 * (`tests/visual/screenshotTolerance.ts#effectiveAllowance`).
 */

/** One measurement line of the report. */
interface Measurement {
  readonly perturbation: string;
  readonly detail: string;
  readonly diffPixels: number;
  readonly passesOld: boolean;
  /** The count at each `THRESHOLD_SWEEP` threshold, keyed by the threshold. */
  readonly byThreshold: Readonly<Record<string, number>>;
}

/** One measured variant of the report. */
interface CaseResult {
  readonly id: string;
  readonly mode: 'page' | 'element';
  readonly target: string | undefined;
  readonly width: number;
  readonly height: number;
  readonly area: number;
  readonly measurements: Measurement[];
}

/** The area the sweep would compare this shot at, and whether the count is within the OLD tolerance. */
function verdict(area: number, diffPixels: number): boolean {
  return diffPixels <= effectiveAllowance(area, OLD_TOLERANCE);
}

/** The markdown table of a finished run. */
function markdownTable(results: readonly CaseResult[]): string {
  const lines = [
    `| Variant | Mode | Area (px) | Perturbation | Diff px | Old allowance | Old verdict | ${THRESHOLD_SWEEP.map((t) => `@${t}`).join(' | ')} |`,
    `| --- | --- | --- | --- | --- | --- | --- | ${THRESHOLD_SWEEP.map(() => '---').join(' | ')} |`,
  ];
  for (const result of results) {
    for (const measurement of result.measurements) {
      const allowance = effectiveAllowance(result.area, OLD_TOLERANCE);
      lines.push(
        `| ${result.id} | ${result.mode} | ${result.area} | ${measurement.perturbation}: ${measurement.detail} | ${measurement.diffPixels} | ${Math.round(allowance)} | ${measurement.passesOld ? 'PASS' : 'FAIL'} | ${THRESHOLD_SWEEP.map((t) => measurement.byThreshold[String(t)]).join(' | ')} |`,
      );
    }
  }
  return lines.join('\n');
}

/** The registry variant of a case, with the guard that the probe measures a resting page. */
function variantOf(calibrationCase: CalibrationCase): Variant {
  const variant = VARIANTS[calibrationCase.view].find((candidate) => candidate.id === calibrationCase.variant);
  if (variant === undefined) throw new Error(`${calibrationCase.view}: no variant "${calibrationCase.variant}"`);
  const steps = [
    variant.click,
    variant.hover,
    variant.fill,
    variant.runtimeOpen,
    variant.agentPopover,
    variant.ticketDetails,
    variant.pills?.length === 0 ? undefined : variant.pills,
    variant.clicks?.length === 0 ? undefined : variant.clicks,
    variant.replies?.length === 0 ? undefined : variant.replies,
  ];
  if (steps.some((step) => step !== undefined)) {
    throw new Error(`${calibrationCase.id}: the probe measures a resting page, but this variant has an interaction step`);
  }
  return variant;
}

/**
 * Replace `from` with `to` in the first VISIBLE text node of the region (the
 * page body for a page capture). A script or style node is skipped: its text
 * never renders. Throws when no visible node holds the label, so a stale case
 * fails loudly instead of measuring a change nobody can see.
 */
async function replaceVisibleText(
  page: import('@playwright/test').Page,
  selector: string | undefined,
  from: string,
  to: string,
): Promise<void> {
  const replaced = await page.evaluate(
    ({ sel, from: search, to: replacement }) => {
      const root: ParentNode = sel === null ? document.body : (document.querySelector(sel) ?? document.body);
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const parent = node.parentElement;
        if (parent === null) continue;
        if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(parent.tagName)) continue;
        if (!(node.textContent ?? '').includes(search)) continue;
        const box = parent.getBoundingClientRect();
        if (box.width === 0 || box.height === 0 || !parent.checkVisibility()) continue;
        node.textContent = (node.textContent ?? '').replace(search, replacement);
        return true;
      }
      return false;
    },
    { sel: selector ?? null, from, to },
  );
  if (!replaced) throw new Error(`no visible text node inside ${selector ?? 'the page'} contains "${from}"`);
}

test('measures the differing pixels of a small perturbation in each capture mode', async ({ gotoView, page }, testInfo) => {
  test.setTimeout(30 * 60 * 1000);
  const project = testInfo.project.name;
  // The project viewport (Desktop Chrome 1280x720). A variant that declares no size keeps it, so it must be
  // restored for every page: the sweep opens each variant in a fresh page, while this probe reuses one.
  const defaultViewport = page.viewportSize() ?? { width: 1280, height: 720 };
  const results: CaseResult[] = [];
  for (const calibrationCase of CASES) {
    const variant = variantOf(calibrationCase);
    if (!variant.themes.includes(project)) {
      // Most component variants are dark-only (ui:VISUAL-VARIANTS): no light or hc page exists to render.
      console.log(`${project} | ${calibrationCase.id} | skipped: this theme records no baseline for it`);
      continue;
    }
    const target = variant.captureTarget;

    /** The page as the sweep opens it: same viewport rule, same fixture, same ready wait. */
    const open = async (): Promise<void> => {
      await page.setViewportSize({
        width: variant.width ?? defaultViewport.width,
        height: variant.viewportHeight ?? defaultViewport.height,
      });
      await gotoView(calibrationCase.view, { variant: variant.id, ...(variant.route === undefined ? {} : { route: variant.route }) });
    };
    /** The shot the sweep records: the element for a component variant, else the (full) page. */
    const capture = async (): Promise<Buffer> => {
      const options = {
        animations: 'disabled' as const,
        caret: 'hide' as const,
        mask: [page.locator(TIME_MASKS)],
      };
      return target === undefined
        ? page.screenshot({ ...options, fullPage: screenshotFullPage(variant) })
        : page.locator(target).screenshot(options);
    };

    await open();
    const base = await capture();
    const size = pngArea(base);
    const colourValue = (
      await page.evaluate(
        (token) => getComputedStyle(document.documentElement).getPropertyValue(token).trim(),
        calibrationCase.colourToken,
      )
    ).toString();
    if (colourValue === '') throw new Error(`${calibrationCase.id}: ${calibrationCase.colourToken} has no computed value`);

    const measurements: Measurement[] = [];
    const record = (perturbation: string, detail: string, shot: Buffer): void => {
      const byThreshold = Object.fromEntries(THRESHOLD_SWEEP.map((t) => [String(t), countDifferingPixels(shot, base, t)]));
      const diffPixels = countDifferingPixels(shot, base);
      const passesOld = verdict(size.area, countDifferingPixels(shot, base, OLD_TOLERANCE.threshold));
      measurements.push({ perturbation, detail, diffPixels, passesOld, byThreshold });
      const sweep = THRESHOLD_SWEEP.map((t) => `${t}:${byThreshold[String(t)]}`).join(' ');
      console.log(`${project} | ${calibrationCase.id} | ${perturbation} | ${detail} | ${diffPixels} px | ${sweep}`);
    };

    // (c) the noise floor: the same page rendered twice with no perturbation.
    for (let repeat = 1; repeat <= NOISE_REPEATS; repeat++) {
      await open();
      record('noise', `repeat ${repeat}`, await capture());
    }

    // (a) one colour custom property shifted by a small per-channel step.
    for (const delta of COLOUR_STEPS) {
      await open();
      await page.addStyleTag({ content: `:root { ${calibrationCase.colourToken}: ${shiftColour(colourValue, delta)} }` });
      record('colour', `${calibrationCase.colourToken} ${colourValue} -> ${shiftColour(colourValue, delta)} (${delta}/channel)`, await capture());
    }

    // (b) a 1-2 word label change, then a single-digit change in a visible label.
    await open();
    await replaceVisibleText(page, target, calibrationCase.words.from, calibrationCase.words.to);
    record('words', `"${calibrationCase.words.from}" -> "${calibrationCase.words.to}"`, await capture());
    if (calibrationCase.digit !== undefined) {
      await open();
      await replaceVisibleText(page, target, calibrationCase.digit.from, calibrationCase.digit.to);
      record('digit', `"${calibrationCase.digit.from}" -> "${calibrationCase.digit.to}"`, await capture());
    }

    results.push({
      id: calibrationCase.id,
      mode: target === undefined ? 'page' : 'element',
      target,
      width: size.width,
      height: size.height,
      area: size.area,
      measurements,
    });
  }

  const directory = join(process.cwd(), 'tests', 'visual', '.report', 'calibration');
  mkdirSync(directory, { recursive: true });
  const payload = { project, threshold: THRESHOLD, thresholdSweep: THRESHOLD_SWEEP, oldTolerance: OLD_TOLERANCE, noiseRepeats: NOISE_REPEATS, colourSteps: COLOUR_STEPS, cases: results };
  writeFileSync(join(directory, `tolerance-${project}.json`), `${JSON.stringify(payload, null, 2)}\n`);
  const table = markdownTable(results);
  writeFileSync(join(directory, `tolerance-${project}.md`), `# T1367 screenshot tolerance measurements (${project})\n\n${table}\n`);
  console.log(table);
});
