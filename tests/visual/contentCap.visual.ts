import type { Page } from '@playwright/test';
import { test as karstTest } from './fixtures.js';
import { expect } from '@playwright/test';
import type { ViewId } from './corpora.js';
import { LAYOUT_HEIGHT } from '../../src/ui/layout/layoutBreakpoints.js';

/** UI-R48: capped views stay ≤ their cap and centered; uncapped views fill the viewport. */

interface Geo { cap: number; contentW: number; left: number; right: number }

async function bodyGeo(page: Page): Promise<Geo> {
  return page.evaluate(() => {
    const cs = getComputedStyle(document.body);
    const r = document.body.getBoundingClientRect();
    const px = (v: string) => parseFloat(v) || 0;
    const contentW = cs.boxSizing === 'border-box'
      ? r.width - (px(cs.paddingLeft) + px(cs.paddingRight) + px(cs.borderLeftWidth) + px(cs.borderRightWidth))
      : px(cs.width);
    return { cap: parseFloat(cs.maxWidth), contentW, left: r.left, right: r.right };
  });
}

function assertCapped(g: Geo, viewport: number, expectedCap?: number): void {
  expect(Number.isFinite(g.cap)).toBe(true);
  if (expectedCap !== undefined) expect(g.cap).toBeCloseTo(expectedCap, 0);
  expect(g.contentW).toBeLessThanOrEqual(g.cap + 1);
  expect(Math.abs(g.left - (viewport - g.right))).toBeLessThanOrEqual(2);
}

const CAPPED: ReadonlyArray<readonly [ViewId, number | undefined]> = [
  ['settings', 1600],
  ['ticketForm', 1600],
  ['usage', 1600],
  ['dashboard', 1600], // centered is the default mode (T1183)
  ['resources', 1600],
  ['gettingStarted', undefined], // 58ch, no token
];
const UNCAPPED: readonly ViewId[] = ['diffs', 'serverLogs', 'sidebar'];

karstTest.describe('content width cap (UI-R48)', () => {
  for (const [view, cap] of CAPPED) {
    karstTest(`${view}: capped and centered at 2560`, async ({ gotoView, page }) => {
      await page.setViewportSize({ width: 2560, height: LAYOUT_HEIGHT });
      await gotoView(view);
      assertCapped(await bodyGeo(page), 2560, cap);
    });
  }

  for (const [view, cap, width] of [['gettingStarted', undefined, 1280], ['settings', 1600, 1920]] as const) {
    karstTest(`${view}: centered at ${width}`, async ({ gotoView, page }) => {
      await page.setViewportSize({ width, height: LAYOUT_HEIGHT });
      await gotoView(view);
      assertCapped(await bodyGeo(page), width, cap);
    });
  }

  karstTest('dashboard: Full width mode fills the viewport at 2560', async ({ gotoView, page }) => {
    await page.setViewportSize({ width: 2560, height: LAYOUT_HEIGHT });
    await gotoView('dashboard');
    // The host's `layout` push is what the menu's Layout setting ends in.
    await page.evaluate(() => window.postMessage({ type: 'layout', layout: 'full' }, '*'));
    await page.waitForFunction(() => document.body.dataset.layout === 'full');
    const w = await page.evaluate(() => document.body.getBoundingClientRect().width);
    expect(w).toBeGreaterThanOrEqual(2560 - 2);
  });

  /** The artifact drill-down follows the page width owner (body[data-layout]), not its own cap. */
  async function artViewGeo(page: Page): Promise<{ w: number; left: number; right: number }> {
    await page.waitForSelector('#artView:not(.hidden)');
    return page.evaluate(() => {
      const el = document.getElementById('artView');
      const cs = el === null ? null : getComputedStyle(el);
      const r = el?.getBoundingClientRect();
      const px = (v: string | undefined) => parseFloat(v ?? '0') || 0;
      return {
        w: (r?.width ?? 0) - px(cs?.paddingLeft) - px(cs?.paddingRight),
        left: r?.left ?? 0,
        right: r?.right ?? 0,
      };
    });
  }

  karstTest('dashboard artifact index: Centered mode is capped and centered at 2560', async ({ gotoView, page }) => {
    await page.setViewportSize({ width: 2560, height: LAYOUT_HEIGHT });
    await gotoView('dashboard', { variant: 'drill-index-wide' });
    const g = await artViewGeo(page);
    expect(g.w).toBeLessThanOrEqual(1600 + 1);
    // Not the legacy 720px column: it fills the capped body.
    expect(g.w).toBeGreaterThan(1200);
    expect(Math.abs(g.left - (2560 - g.right))).toBeLessThanOrEqual(2);
  });

  karstTest('dashboard artifact index: Full width mode fills the viewport at 2560', async ({ gotoView, page }) => {
    await page.setViewportSize({ width: 2560, height: LAYOUT_HEIGHT });
    await gotoView('dashboard', { variant: 'drill-index-wide' });
    await page.evaluate(() => window.postMessage({ type: 'layout', layout: 'full' }, '*'));
    await page.waitForFunction(() => document.body.dataset.layout === 'full');
    const g = await artViewGeo(page);
    expect(g.w).toBeGreaterThanOrEqual(2560 - 200);
  });

  for (const view of UNCAPPED) {
    karstTest(`${view}: full width at 2560`, async ({ gotoView, page }) => {
      await page.setViewportSize({ width: 2560, height: LAYOUT_HEIGHT });
      await gotoView(view);
      const w = await page.evaluate(() => document.body.getBoundingClientRect().width);
      expect(w).toBeGreaterThanOrEqual(2560 - 2);
    });
  }
});
