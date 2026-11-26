/**
 * Playwright config for the T1367 tolerance probe (`@ui:VISUAL-TOLERANCE`).
 *
 * It reuses the sweep's config (webServer, fixtures, `expect` defaults, the
 * three theme projects) and changes only what the probe needs:
 *  - `testDir`/`testMatch` keep the probe out of the sweep: the sweep matches
 *    `**\/*.visual.ts`, the probe is a `*.calibrate.ts`.
 *  - a long timeout: one test renders each variant nine times.
 *  - a snapshot path outside `tests/visual/__baselines__`: the probe compares
 *    buffers, it records no baseline.
 *
 * The measure is per capture mode, but it runs in all three themes because a
 * darker background changes the anti-aliasing of the same glyph, and the
 * element-mode allowance must hold in the theme that renders the smallest diff.
 *
 * `npm run -s test:visual:calibrate:docker` runs it in the same pinned image
 * as the sweep; that image is the only rendering environment where a pixel
 * count means anything (docs/ui/VISUAL-COVERAGE.md, @ui:RUNNING-SWEEP).
 */
import { devices, type PlaywrightTestConfig, type Project } from '@playwright/test';
import sweep from './playwright.config.js';

/** A screenshot project of the sweep, copied so the probe measures the same pages. */
function themeProject(name: string, colorScheme: 'dark' | 'light'): Project {
  return { name, use: { ...devices['Desktop Chrome'], channel: undefined, colorScheme } };
}

const config: PlaywrightTestConfig = {
  ...sweep,
  testDir: 'tests/visual/calibration',
  testMatch: '**/*.calibrate.ts',
  // One test renders each variant up to eight times (base, three noise repeats,
  // two tint steps, the word change and the digit change); a page load is fast,
  // but the fixture server builds every page of the selected views first.
  timeout: 30 * 60 * 1000,
  snapshotPathTemplate: 'tests/visual/.report/calibration/__snapshots__/{projectName}/{arg}{ext}',
  reporter: [['list']],
  projects: [themeProject('dark', 'dark'), themeProject('light', 'light'), themeProject('hc', 'dark')],
};

export default config;
