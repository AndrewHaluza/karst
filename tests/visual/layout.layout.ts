/**
 * Layout-sanity gate (project `layout`): opens EVERY settings route at each
 * LAYOUT_WIDTHS with the `realistic` corpus, runs checks a–h
 * (src/ui/layout/layoutChecks.ts) and writes one shard per route x width. These
 * tests NEVER fail on geometry — the ledger verdict lives in layout.teardown.ts —
 * so a harness error is the only way they go red. No screenshots, no baselines.
 *
 * Check i (state survives a 1280→480→1280 resize) runs once per Agents hash.
 * Geometry is theme-independent, so only the dark `layout` project runs this.
 * Filter by FILE (`playwright test --project=layout <file>`), never --grep: a
 * title filter can drop the layout-teardown test.
 */
import { test } from './fixtures.js';
import { LAYOUT_HEIGHT, LAYOUT_WIDTHS, tierFor } from '../../src/ui/layout/layoutBreakpoints.js';
import { runChecks, stateSurvivesResize, type ResizeState } from '../../src/ui/layout/layoutChecks.js';
import { collectSnapshot } from './layoutSnapshot.js';
import { readExpectations, writeShard } from './layoutShards.js';
import { resizeRouteId, settingsRoutes } from './settingsRoutes.js';

const RESIZE_NARROW = 480;
const RESIZE_WIDE = 1280;

for (const route of settingsRoutes()) {
  const openRoute = { section: route.section, ...(route.hash === undefined ? {} : { hash: route.hash }) };

  for (const width of LAYOUT_WIDTHS) {
    test(`${route.id} @${width}`, async ({ gotoView, page }) => {
      await page.setViewportSize({ width, height: LAYOUT_HEIGHT });
      await gotoView('settings', { scenario: 'realistic', route: openRoute });
      const expectations = readExpectations(route.section);
      const snapshot = await collectSnapshot(page);
      const failures = runChecks(snapshot, expectations?.[tierFor(width)]).map((f) => ({ ...f, route: route.id, width }));
      writeShard({ route: route.id, width, failures, unchecked: expectations === undefined });
    });
  }

  if (route.section === 'agents') {
    test(`${route.id} state survives resize`, async ({ gotoView, page }) => {
      await page.setViewportSize({ width: RESIZE_WIDE, height: LAYOUT_HEIGHT });
      await gotoView('settings', { scenario: 'realistic', route: openRoute });
      const readState = (): Promise<ResizeState> =>
        page.evaluate(() => ({
          hash: window.location.hash,
          selected: document.querySelector('[aria-selected="true"], [aria-current="true"]')?.textContent?.trim() ?? null,
        }));
      const before = await readState();
      await page.setViewportSize({ width: RESIZE_NARROW, height: LAYOUT_HEIGHT });
      await page.waitForTimeout(100);
      await page.setViewportSize({ width: RESIZE_WIDE, height: LAYOUT_HEIGHT });
      await page.waitForTimeout(100);
      const failures = stateSurvivesResize(before, await readState()).map((f) => ({ ...f, route: resizeRouteId(route.id), width: RESIZE_NARROW }));
      writeShard({ route: resizeRouteId(route.id), width: RESIZE_NARROW, failures, unchecked: false });
    });
  }
}
