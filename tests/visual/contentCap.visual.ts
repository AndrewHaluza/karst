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
  ['settings', 1200],
  ['ticketForm', 1200],
  ['usage', 1600],
  ['resources', 1600],
  ['gettingStarted', undefined], // 58ch, no token
];
const UNCAPPED: readonly ViewId[] = ['dashboard', 'diffs', 'serverLogs', 'sidebar'];

karstTest.describe('content width cap (UI-R48)', () => {
  for (const [view, cap] of CAPPED) {
    karstTest(`${view}: capped and centered at 2560`, async ({ gotoView, page }, testInfo) => {
      if (testInfo.project.name !== 'dark') { testInfo.skip(); return; }
      await page.setViewportSize({ width: 2560, height: LAYOUT_HEIGHT });
      await gotoView(view);
      assertCapped(await bodyGeo(page), 2560, cap);
    });
  }

  for (const [view, cap] of [['gettingStarted', undefined], ['settings', 1200]] as const) {
    karstTest(`${view}: centered at 1280`, async ({ gotoView, page }, testInfo) => {
      if (testInfo.project.name !== 'dark') { testInfo.skip(); return; }
      await page.setViewportSize({ width: 1280, height: LAYOUT_HEIGHT });
      await gotoView(view);
      assertCapped(await bodyGeo(page), 1280, cap);
    });
  }

  for (const view of UNCAPPED) {
    karstTest(`${view}: full width at 2560`, async ({ gotoView, page }, testInfo) => {
      if (testInfo.project.name !== 'dark') { testInfo.skip(); return; }
      await page.setViewportSize({ width: 2560, height: LAYOUT_HEIGHT });
      await gotoView(view);
      const w = await page.evaluate(() => document.body.getBoundingClientRect().width);
      expect(w).toBeGreaterThanOrEqual(2560 - 2);
    });
  }
});
