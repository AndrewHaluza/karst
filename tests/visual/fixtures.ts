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
  theme: async ({}, use, testInfo) => {
    // Theme is derived from the project name (e.g., 'dark', 'light', 'hc',
    // 'dark-grayscale', 'dark-reduced-motion', 'catalog').
    // The base theme is the first part before any hyphen.
    const name = testInfo.project.name;
    const themeMap: Record<string, ThemeId> = {
      dark: 'dark',
      light: 'light',
      hc: 'hc',
      'dark-grayscale': 'dark',
      'dark-reduced-motion': 'dark',
      catalog: 'dark',
    };
    await use((themeMap[name] ?? 'dark') as ThemeId);
  },

  gotoView: async ({ page, theme }, use) => {
    const goto = async (view: ViewId, opts?: { scenario?: string }) => {
      let filename = `${view}.html`;
      if (view === 'dashboard') {
        filename = `dashboard-${opts?.scenario ?? 'pending'}.html`;
      }
      const path = `/${theme}/${filename}`;
      const fullUrl = new URL(path, 'http://127.0.0.1:4317').toString();
      await page.goto(fullUrl, { waitUntil: 'load', timeout: 60_000 });
      // The seed script sets data-karst-ready on <html> after dispatching messages.
      // Poll briefly for it — the script runs inline and should be fast, but large
      // pages may need a tick.
      for (let i = 0; i < 50; i++) {
        const ready = await page.locator('[data-karst-ready]').count();
        if (ready > 0) break;
        await page.waitForTimeout(100);
      }
      return page;
    };
    await use(goto);
  },
});

export { expect };
