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
      caret: 'hidden',
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
    teardown: undefined,
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
      use: {
        ...devices['Desktop Chrome'],
        channel: undefined,
        colorScheme: 'dark',
        theme: 'dark',
      },
    },
    {
      name: 'light',
      use: {
        ...devices['Desktop Chrome'],
        channel: undefined,
        colorScheme: 'light',
        theme: 'light',
      },
    },
    {
      name: 'hc',
      use: {
        ...devices['Desktop Chrome'],
        channel: undefined,
        colorScheme: 'dark',
        theme: 'hc',
      },
    },
    {
      name: 'dark-grayscale',
      use: {
        ...devices['Desktop Chrome'],
        channel: undefined,
        colorScheme: 'dark',
        theme: 'dark',
        // Grayscale filter applied via page CSS, not Playwright option.
        // This project is used only by the status spec (UI-R28).
      },
    },
    {
      name: 'dark-reduced-motion',
      use: {
        ...devices['Desktop Chrome'],
        channel: undefined,
        colorScheme: 'dark',
        theme: 'dark',
        reducedMotion: 'reduce',
      },
    },
    {
      name: 'catalog',
      use: {
        ...devices['Desktop Chrome'],
        channel: undefined,
        colorScheme: 'dark',
        theme: 'dark',
      },
    },
  ],
});
