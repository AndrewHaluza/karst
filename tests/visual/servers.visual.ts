import { test, expect, type Page } from '@playwright/test';
import { buildFixture } from './buildFixture.js';
import { LAYOUT_HEIGHT, LAYOUT_WIDTHS, NARROW_MAX, tierFor } from '../../src/ui/layout/layoutBreakpoints.js';
import { fixtureMessages, resourcesRenderFixtures } from '../../src/ui/resources/renderFixtures.js';

/**
 * Servers & resources page geometry, in a real browser, at every layout tier
 * (ui:UI-R43, UI-R45, UI-R47): no horizontal page scroll, regions stacked in
 * order, no scroll container nested inside the pane, the action cluster wrapping
 * under the name at <=699, and the selected tab surviving a resize across tiers.
 *
 * Geometry is theme-independent, so this runs in the dark project only and keeps
 * no screenshot baseline.
 */
const SCENARIOS = ['servers-mixed', 'servers-hostile', 'servers-none', 'servers-done'] as const;
const TOLERANCE = 2;

async function open(page: Page, scenario: string, width: number): Promise<void> {
  const fixture = resourcesRenderFixtures().find((f) => f.scenario === scenario)!;
  await page.setViewportSize({ width, height: LAYOUT_HEIGHT });
  await page.setContent(buildFixture('resources', 'dark', fixtureMessages(fixture)), { waitUntil: 'load' });
  await page.locator('#panel-servers .stat').first().waitFor();
}

test.describe('Servers tab geometry (UI-R43/R45/R47)', () => {
  test.beforeEach(({}, testInfo) => {
    if (testInfo.project.name !== 'dark') testInfo.skip();
  });

  for (const scenario of SCENARIOS) {
    for (const width of LAYOUT_WIDTHS) {
      test(`${scenario} @${width}: no sideways scroll, ordered regions, no nested scroller`, async ({ page }) => {
        await open(page, scenario, width);
        const geo = await page.evaluate(() => {
          const root = document.documentElement;
          const rect = (sel: string) => {
            const el = document.querySelector(sel);
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { y: r.y, h: r.height, x: r.x, w: r.width };
          };
          const pane = document.querySelector('#panel-servers')!;
          const scrollers = [...pane.querySelectorAll('*')].filter((el) => {
            const cs = getComputedStyle(el);
            const x = (cs.overflowX === 'auto' || cs.overflowX === 'scroll') && el.scrollWidth > el.clientWidth + 2;
            const y = (cs.overflowY === 'auto' || cs.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 2;
            return x || y;
          }).map((el) => el.className);
          return {
            sideways: root.scrollWidth - root.clientWidth,
            toolbar: rect('#panel-servers [data-region=toolbar]'),
            main: rect('#panel-servers [data-region=main]'),
            footer: rect('#panel-servers [data-region=footer]'),
            scrollers,
          };
        });
        expect(geo.sideways, 'horizontal page scroll').toBeLessThanOrEqual(1);
        expect(geo.scrollers, 'nested scroll containers').toEqual([]);
        if (geo.toolbar) expect(geo.main!.y).toBeGreaterThanOrEqual(geo.toolbar.y + geo.toolbar.h - TOLERANCE);
        expect(geo.footer!.y).toBeGreaterThanOrEqual(geo.main!.y + geo.main!.h - TOLERANCE);
      });
    }
  }

  test('at <=699 the action cluster wraps under the name; wide keeps it beside', async ({ page }) => {
    await open(page, 'servers-mixed', NARROW_MAX);
    const narrow = await page.evaluate(() =>
      [...document.querySelectorAll('#panel-servers .srow')].map((row) => {
        const id = row.querySelector('.srow-id')!.getBoundingClientRect();
        const act = row.querySelector('.srow-actions')!.getBoundingClientRect();
        return act.y >= id.y + id.height - 2;
      }),
    );
    expect(narrow.length).toBeGreaterThan(0);
    expect(narrow.every(Boolean)).toBe(true);

    await open(page, 'servers-mixed', 1280);
    const wide = await page.evaluate(() => {
      const row = document.querySelector('#panel-servers .srow')!;
      const id = row.querySelector('.srow-id')!.getBoundingClientRect();
      const act = row.querySelector('.srow-actions')!.getBoundingClientRect();
      return act.x >= id.x + id.width - 2 && Math.abs(act.y - id.y) < id.height + 20;
    });
    expect(wide).toBe(true);
  });

  test('the selected tab and its hash survive a resize across every tier', async ({ page }) => {
    await open(page, 'servers-mixed', 1280);
    const hash = () => page.evaluate(() => ({
      hash: window.location.hash,
      selected: document.querySelector('[role=tab][aria-selected=true]')?.id,
    }));
    expect(await hash()).toEqual({ hash: '#servers', selected: 'tab-servers' });
    const seen = new Set<string>();
    for (const width of [1280, 900, 699, 480, 900, 1280]) {
      await page.setViewportSize({ width, height: LAYOUT_HEIGHT });
      seen.add(tierFor(width));
      expect(await hash(), `@${width}`).toEqual({ hash: '#servers', selected: 'tab-servers' });
    }
    expect(seen).toEqual(new Set(['wide', 'mid', 'narrow']));
    await page.goBack().catch(() => undefined);
    expect((await hash()).selected).toBeDefined();
  });

  test('long and hostile names wrap instead of overflowing their row', async ({ page }) => {
    await open(page, 'servers-hostile', 480);
    const overflowing = await page.evaluate(() => {
      const pane = document.querySelector('#panel-servers')!.getBoundingClientRect();
      return [...document.querySelectorAll('#panel-servers .sname, #panel-servers .gname, #panel-servers .deps, #panel-servers .flag')]
        .filter((el) => el.getBoundingClientRect().right > pane.right + 1)
        .map((el) => el.className);
    });
    expect(overflowing).toEqual([]);
  });
});
