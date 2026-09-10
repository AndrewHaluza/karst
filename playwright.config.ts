import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for the karst visual-regression sweep.
 *
 * Renders every karst webview through its real injector chain into headless
 * Chromium, in three forced VS Code themes, and pins the result against
 * checked-in baselines.  See docs/ui/VISUAL-COVERAGE.md for which UI-RULES.md
 * VISUAL rules this covers.
 *
 * The five projects:
 *   dark / light / hc          — three themes, all specs
 *   dark-grayscale             — dark + CSS grayscale filter, status spec only (UI-R28)
 *   dark-reduced-motion        — dark + prefers-reduced-motion, status spec only (UI-R30)
 *   catalog                    — the standalone catalog page, dark only (D15)
 *
 * Baselines are CONTAINER-AUTHORED. `snapshotPathTemplate` carries no
 * {platform} token, so one set serves every OS — and macOS and Linux rasterize
 * glyphs differently. Author and update baselines only through
 * `npm run test:visual:docker:update`, which runs the pinned
 * mcr.microsoft.com/playwright:v1.63.0-noble image. A bare `npm run test:visual`
 * on macOS is a local smoke run; its diffs are not authoritative.
 *
 * CI runs the same image in .github/workflows/ci.yml's `visual` job (advisory).
 */
export default defineConfig({
  testDir: 'tests/visual',
  testMatch: '**/*.visual.ts',

  snapshotPathTemplate:
    'tests/visual/__baselines__/{projectName}/{arg}{ext}',

  expect: {
    toHaveScreenshot: {
      threshold: 0.2,
      maxDiffPixelRatio: 0.002,
      maxDiffPixels: 400,
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

  webServer: {
    command: 'node tests/visual/serve.mjs',
    url: 'http://127.0.0.1:4317/healthz',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },

  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'tests/visual/.report' }],
  ],

  projects: [
    {
      name: 'dark',
      use: { ...devices['Desktop Chrome'], channel: undefined, colorScheme: 'dark' },
    },
    {
      name: 'light',
      use: { ...devices['Desktop Chrome'], channel: undefined, colorScheme: 'light' },
    },
    {
      name: 'hc',
      use: { ...devices['Desktop Chrome'], channel: undefined, colorScheme: 'dark' },
    },
    {
      name: 'dark-grayscale',
      use: { ...devices['Desktop Chrome'], channel: undefined, colorScheme: 'dark' },
    },
    {
      name: 'dark-reduced-motion',
      use: { ...devices['Desktop Chrome'], channel: undefined, colorScheme: 'dark', reducedMotion: 'reduce' },
    },
    {
      name: 'catalog',
      use: { ...devices['Desktop Chrome'], channel: undefined, colorScheme: 'dark' },
    },
  ],
});
