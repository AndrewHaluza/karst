import { expect } from '@playwright/test';
import { test as karstTest } from './fixtures.js';
import { VARIANTS } from './variants.js';
import { WEBVIEW_NAMES } from '../../src/model/webviewChains.js';

/**
 * Full-page screenshot baselines: every registered variant of every webview
 * (tests/visual/variants.ts, ui:UI-R57), in the theme projects the variant
 * declares. A variant outside the running project's theme list is skipped, so
 * the matrix is: populated variants in dark/light/hc, every other variant in dark
 * (split documented in ui:VISUAL-VARIANTS). variants.test.ts fails when a
 * declared baseline PNG is missing or a PNG has no variant.
 *
 * Masks:
 * - Dashboard terminal region (D12: xterm not injected)
 * - Any element with a live clock or elapsed-time readout
 */

/** Selectors for elements that display live time and must be masked. */
const TIME_MASKS = [
  '[data-karst-clock]',   // generic clock hook
  '.k-clock',             // clock primitive
  '[data-elapsed]',       // elapsed-time readout
].join(', ');

karstTest.describe('full-page screenshots', () => {
  for (const view of WEBVIEW_NAMES) {
    for (const v of VARIANTS[view]) {
      karstTest(`${view}/${v.id}: full-page screenshot`, async ({ gotoView, page }, testInfo) => {
        if (!v.themes.includes(testInfo.project.name)) {
          testInfo.skip();
          return;
        }
        if (v.width !== undefined) await page.setViewportSize({ width: v.width, height: (page.viewportSize()?.height ?? 720) });
        await gotoView(view, { variant: v.id, ...(v.route === undefined ? {} : { route: v.route }) });
        for (const pill of v.pills ?? []) await page.getByRole('button', { name: new RegExp(`^${pill}`) }).first().click();
        if (v.id.startsWith('drill-')) {
          // UI-R43: no sideways page scroll at any tier.
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
        }
        if (v.id === 'attention') {
          await page.locator('.attention-ring').evaluate((el) => {
            el.classList.add('pulsing');
            el.classList.remove = () => {};
          });
        }
        await expect(page).toHaveScreenshot(`${v.baseline}.png`, {
          fullPage: true,
          mask: [page.locator(TIME_MASKS)],
        });
      });
    }
  }
});
