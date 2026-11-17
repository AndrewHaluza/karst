import { expect, type Page } from '@playwright/test';
import { test as karstTest } from './fixtures.js';
import { outsideTags } from './projectFilter.js';
import { screenshotFullPage, VARIANTS } from './variants.js';
import { WEBVIEW_NAMES } from '../../src/model/webviewChains.js';

const SETTLE_MAX_FRAMES = 120;

/**
 * T1150: an anchored popover is placed in a requestAnimationFrame after it opens (T1091) and re-placed on resize (#1071).
 * Wait until every visible position:fixed box (the popovers) has the same bounding box on two frames in a row, so the
 * shot never catches a popover mid-placement or mid-flip. A page with no fixed box settles after two frames.
 */
async function waitForPopoversSettled(page: Page): Promise<void> {
  const settled = await page.evaluate(
    (maxFrames) =>
      new Promise<boolean>((done) => {
        const snapshot = (): string =>
          Array.from(document.body.querySelectorAll<HTMLElement>('*'))
            .filter((el) => getComputedStyle(el).position === 'fixed')
            .map((el) => {
              const r = el.getBoundingClientRect();
              return r.width === 0 && r.height === 0 ? '' : `${r.x},${r.y},${r.width},${r.height}`;
            })
            .join('|');
        let previous = '';
        let frames = 0;
        const tick = (): void => {
          frames += 1;
          const current = snapshot();
          if (frames > 1 && current === previous) return done(true);
          if (frames >= maxFrames) return done(false);
          previous = current;
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    SETTLE_MAX_FRAMES,
  );
  expect(settled, 'an open popover kept moving: its placement never settled').toBe(true);
}

/**
 * Full-page screenshot baselines: every registered variant of every webview
 * (tests/visual/variants.ts, ui:UI-R57), in the theme projects the variant
 * declares. Each test carries a `@NOT-<PROJECT>` tag for every project outside
 * its themes, and that project's `grepInvert` drops it before any fixture setup
 * (tests/visual/projectFilter.ts). So the matrix is: populated variants in
 * dark/light/hc, every other variant in dark (split documented in
 * ui:VISUAL-VARIANTS). variants.test.ts fails when a
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
      karstTest(`${view}/${v.id}: full-page screenshot`, { tag: outsideTags(v.themes) }, async ({ gotoView, page }) => {
        if (v.width !== undefined || v.viewportHeight !== undefined) {
          await page.setViewportSize({ width: v.width ?? page.viewportSize()?.width ?? 1100, height: v.viewportHeight ?? page.viewportSize()?.height ?? 720 });
        }
        await gotoView(view, { variant: v.id, ...(v.route === undefined ? {} : { route: v.route }) });
        for (const pill of v.pills ?? []) await page.getByRole('button', { name: new RegExp(`^${pill}`) }).first().click();
        if (v.agentPopover !== undefined) {
          const steps = v.agentPopover;
          await page.locator('#agentButton').click();
          if (steps.core !== undefined) await page.locator(`[data-ap-core-tab="${steps.core}"]`).click();
          if (steps.q !== undefined) await page.locator('[data-ap-search]').fill(steps.q);
          if (steps.cap !== undefined) await page.locator(`[data-ap-cap="${steps.cap}"]`).click();
          if (steps.model !== undefined) await page.locator(`[data-ap-model="${steps.model}"]`).click();
        }
        if (v.ticketDetails !== undefined) {
          await page.locator('#ticketDataBtn').click();
          if (v.ticketDetails.tab !== undefined) await page.locator(`#tdTab-${v.ticketDetails.tab}`).click();
        }
        if (v.runtimeOpen !== undefined) {
          const trigger = v.runtimeOpen === 'sandbox' ? '[data-testid="runtime-strip"] .rs-dd[title^="Sandbox details"]' : '[aria-label="More sandbox actions"]';
          await page.locator(trigger).click();
        }
        if (v.click !== undefined) await page.locator(v.click).first().click();
        for (const sel of v.clicks ?? []) await page.locator(sel).first().click();
        if (v.hover !== undefined) await page.locator(v.hover).first().hover();
        await waitForPopoversSettled(page);
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
          fullPage: screenshotFullPage(v),
          mask: [page.locator(TIME_MASKS)],
        });
      });
    }
  }
});
