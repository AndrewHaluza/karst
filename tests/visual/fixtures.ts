/**
 * Typed Playwright fixture for the visual sweep.
 *
 * Exposes:
 * - `theme`: the ThemeId from the project's `use.theme`
 * - `gotoView(view)`: navigates to `/<theme>/<view>.html` and waits for
 *   `networkidle` plus `[data-karst-ready]`.
 */
import { test as base, expect, type Page } from '@playwright/test';
import type { ThemeId } from './themes.js';
import type { ViewId } from './chains.js';

interface KarstFixtures {
  theme: ThemeId;
  gotoView: (view: ViewId, opts?: { scenario?: string }) => Promise<Page>;
}

export const test = base.extend<KarstFixtures>({
  theme: [async ({}, use, testInfo) => {
    const theme = (testInfo.project.use as Record<string, unknown>).theme as ThemeId;
    await use(theme);
  }, { scope: 'worker' }],

  gotoView: async ({ page, theme }, use) => {
    const goto = async (view: ViewId, opts?: { scenario?: string }) => {
      let path = `/${theme}/${view}.html`;
      if (view === 'dashboard' && opts?.scenario) {
        path = `/${theme}/dashboard-${opts.scenario}.html`;
      }
      await page.goto(path, { waitUntil: 'networkidle' });
      // Wait for the seed script to signal readiness.
      await page.locator('[data-karst-ready]').waitFor({ timeout: 5000 });
      return page;
    };
    await use(goto);
  },
});

export { expect };
