import { defineConfig, devices, type PlaywrightTestOptions, type Project } from '@playwright/test';
import { isMergeRun } from './tests/visual/layoutShards.js';
import { outsideGrep, testIgnoreFor } from './tests/visual/projectFilter.js';
import { PAGE_TOLERANCE } from './tests/visual/screenshotTolerance.js';
import { resolveVisualWorkers } from './tests/visual/visualWorkers.js';
import { WEB_SERVER_STDOUT, WEB_SERVER_TIMEOUT_MS } from './tests/visual/serveLimits.mjs';

/**
 * Playwright config for the karst visual-regression sweep.
 *
 * Renders every karst webview through its real injector chain into headless
 * Chromium, in three forced VS Code themes, and pins the result against
 * checked-in baselines.  See docs/ui/VISUAL-COVERAGE.md for which UI-RULES.md
 * VISUAL rules this covers.
 *
 * The projects:
 *   dark / light / hc          — three themes, all specs
 *   dark-grayscale             — dark + CSS grayscale filter, status spec only (UI-R28)
 *   dark-reduced-motion        — dark + prefers-reduced-motion, status spec only (UI-R30)
 *   catalog                    — the standalone catalog page, dark only (D15)
 *   layout-setup → layout → layout-teardown — the layout-sanity gate (ui:LAYOUT-SANITY):
 *                                geometry checks, dark only, no baselines
 *
 * Baselines are CONTAINER-AUTHORED. `snapshotPathTemplate` carries no
 * {platform} token, so one set serves every OS — and macOS and Linux rasterize
 * glyphs differently. Author and update baselines only through
 * `npm run test:visual:docker:update`, which runs the pinned
 * mcr.microsoft.com/playwright:v1.63.0-noble image. A bare `npm run test:visual`
 * on macOS is a local smoke run; its diffs are not authoritative.
 *
 * CI runs the same image in the `visual-shard` jobs of .github/workflows/ci.yml
 * (the plan is scripts/visual-shards.mjs) and merges their reports in the
 * `visual` job. There, KARST_LAYOUT_MERGE=1 runs the layout ledger verdict over
 * the layout files of all shards, without a web server. Pre-existing
 * diff failures there are advisory, but a pull request's own added/changed
 * baseline that fails its own screenshot fails the job (scripts/visual-sweep-gate.mjs).
 */
// A project-level grep overrides the global one. Local gates narrow the layout routes with the
// same grep as the screenshots. Setup and teardown hold one test each and take no filter, so any
// grep keeps the ledger verdict on the routes that ran, and a filtered seed or prune is refused
// (ui:LAYOUT-SCOPE).
const ALL_TITLES = /.*/;
const UI_GREP = process.env['KARST_UI_GREP'] ? new RegExp(process.env['KARST_UI_GREP']) : undefined;

/**
 * A screenshot project. `testIgnore` and `grepInvert` drop, before any fixture
 * setup, the tests that this project does not run (tests/visual/projectFilter.ts).
 * A project-level `grepInvert` leaves the global `grep` (KARST_UI_GREP) in force.
 */
function screenshotProject(name: string, use: Partial<PlaywrightTestOptions>): Project {
  return {
    name,
    testIgnore: testIgnoreFor(name),
    grepInvert: outsideGrep(name),
    use: { ...devices['Desktop Chrome'], channel: undefined, ...use },
  };
}

// T992: one id per run. The webServer child inherits it and the cleanup reporter compares it; workers re-read this file and keep the id.
process.env.KARST_VISUAL_RUN_ID ??= `${process.pid}-${Date.now()}`;

export default defineConfig({
  testDir: 'tests/visual',
  testMatch: '**/*.visual.ts',

  // Local gates narrow every project to the views the ticket touched (scripts/uiViews.mjs); CI leaves it unset (full chain).
  ...(UI_GREP ? { grep: UI_GREP } : {}),

  snapshotPathTemplate:
    'tests/visual/__baselines__/{projectName}/{arg}{ext}',

  expect: {
    toHaveScreenshot: {
      // @ui:VISUAL-TOLERANCE: the full-page tolerance. An element capture overrides it with ELEMENT_TOLERANCE, and a
      // page in PAGE_KNOWN_DRIFT with its own measured drift (tests/visual/pages.visual.ts, status.visual.ts).
      ...PAGE_TOLERANCE,
      animations: 'disabled',
      caret: 'hide',
    },
  },

  use: {
    deviceScaleFactor: 1,
    timezoneId: 'UTC',
    locale: 'en-US',
    baseURL: 'http://127.0.0.1:4317',
  },

  // The CI layout merge run (isMergeRun, tests/visual/layoutShards.ts) runs only layout-setup and layout-teardown.
  // They open no page, so the job skips the fixture build of serve.mjs.
  ...(isMergeRun()
    ? {}
    : {
        webServer: {
          // KARST_VISUAL_RUN_ID reaches serve.mjs, which records it; the cleanup reporter removes pages only of its own server.
          command: 'node tests/visual/serve.mjs',
          url: 'http://127.0.0.1:4317/healthz',
          reuseExistingServer: !process.env.CI,
          // Covers the whole serve.mjs start (bundles + fixtures + listen); it must exceed the 60 s fixture limit in serve.mjs.
          timeout: WEB_SERVER_TIMEOUT_MS,
          // The start step lines of serve.mjs reach the gate log (about 6 lines for each run).
          stdout: WEB_SERVER_STDOUT,
        },
      }),

  forbidOnly: !!process.env.CI,
  retries: 0,
  // KARST_VISUAL_WORKERS (default 1) raises it for the local docker gate only; see visualWorkers.ts.
  workers: resolveVisualWorkers(process.env, process.argv),
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'tests/visual/.report' }],
    // Machine-readable outcome counts for the CI gate
    // (scripts/visual-sweep-gate.mjs, called by .github/workflows/ci.yml):
    // the sweep step is advisory for screenshot diffs but must fail when the
    // run produced zero executed tests — a webServer/startup crash that used
    // to hide behind `continue-on-error: true` (NDL-218).  Gitignored.
    ['json', { outputFile: 'tests/visual/.results.json' }],
    // T992: a passed run removes the ~800 MB of generated pages (tests/visual/.tmp); a failed run keeps them.
    ['./tests/visual/tmpCleanupReporter.ts'],
  ],

  projects: [
    screenshotProject('dark', { colorScheme: 'dark' }),
    screenshotProject('light', { colorScheme: 'light' }),
    screenshotProject('hc', { colorScheme: 'dark' }),
    screenshotProject('dark-grayscale', { colorScheme: 'dark' }),
    screenshotProject('dark-reduced-motion', { colorScheme: 'dark', reducedMotion: 'reduce' }),
    screenshotProject('catalog', { colorScheme: 'dark' }),
    // Layout-sanity gate. The top-level testMatch stays '**/*.visual.ts' so the
    // other projects never pick up these files. Setup clears the shards, `layout`
    // writes them (never fails on geometry), teardown renders the ledger verdict.
    {
      name: 'layout-setup',
      grep: ALL_TITLES,
      testMatch: '**/layout.setup.ts',
      teardown: 'layout-teardown',
    },
    {
      name: 'layout',
      grep: UI_GREP ?? ALL_TITLES,
      testMatch: '**/*.layout.ts',
      dependencies: ['layout-setup'],
      // One spec file holds the whole chain. Each test writes its own shard and the verdict is the separate teardown
      // project, so the tests are independent: let more than one worker take them (@ui:WORKERS).
      fullyParallel: true,
      use: { ...devices['Desktop Chrome'], channel: undefined, colorScheme: 'dark' },
    },
    {
      name: 'layout-teardown',
      grep: ALL_TITLES,
      testMatch: '**/layout.teardown.ts',
    },
  ],
});
