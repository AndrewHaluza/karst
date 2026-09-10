import { test, expect } from '@playwright/test';
import { test as karstTest } from './fixtures.js';
import { ALL_VIEWS } from './corpora.js';
import type { ViewId } from './corpora.js';
import type { ThemeId } from './themes.js';

const PAGE_PROJECTS: readonly ThemeId[] = ['dark', 'light', 'hc'];

/**
 * Full-page screenshot baselines for all eight webviews in three themes.
 *
 * Masks:
 * - Dashboard terminal region (D12: xterm not injected)
 * - Any element with a live clock or elapsed-time readout
 *
 * Dashboard renders six scenarios as six named shots.
 */

/** Selectors for elements that display live time and must be masked. */
const TIME_MASKS = [
  '[data-karst-clock]',   // generic clock hook
  '.k-clock',             // clock primitive
  '[data-elapsed]',       // elapsed-time readout
].join(', ');

karstTest.describe('full-page screenshots', () => {
  for (const viewId of ALL_VIEWS) {
    if (viewId === 'dashboard') {
      // Dashboard: one shot per scenario.
      const scenarios = ['pending', 'running', 'passed', 'failed', 'waiting', 'exhausted'] as const;
      for (const scenario of scenarios) {
        karstTest(`dashboard-${scenario}: full-page screenshot`, async ({ gotoView, page }, testInfo) => {
          const theme = testInfo.project.use.theme as ThemeId;
          if (!PAGE_PROJECTS.includes(theme)) {
            testInfo.skip();
            return;
          }
          await gotoView(viewId, { scenario });
          await expect(page).toHaveScreenshot(`dashboard-${scenario}.png`, {
            fullPage: true,
            mask: [page.locator(TIME_MASKS)],
          });
        });
      }
    } else {
      karstTest(`${viewId}: full-page screenshot`, async ({ gotoView, page }, testInfo) => {
        const theme = testInfo.project.use.theme as ThemeId;
        if (!PAGE_PROJECTS.includes(theme)) {
          testInfo.skip();
          return;
        }
        await gotoView(viewId);
        await expect(page).toHaveScreenshot(`${viewId}.png`, {
          fullPage: true,
          mask: [page.locator(TIME_MASKS)],
        });
      });
    }
  }
});
