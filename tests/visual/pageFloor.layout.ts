/**
 * Page-floor gate (project `layout`): at 280 px — narrower than the 320 px floor
 * — every EDITOR webview keeps its 320 px layout and the page scrolls sideways
 * (`--k-page-floor`, UI-R43, UI-R49). The sidebar webview opts out with
 * `data-k-floor="off"` (the VS Code side bar is routinely narrower, D860), so it
 * must not scroll.
 *
 * This spec asserts directly and writes no ledger shard; it does not touch
 * `tests/visual/layout-known-failures.json` or any baseline.
 */
import { LAYOUT_HEIGHT, PAGE_FLOOR } from '../../src/ui/layout/layoutBreakpoints.js';
import { expect, test } from './fixtures.js';
import { fixtureViewsFromEnv } from './fixtureScope.js';
import { settingsRoutes } from './settingsRoutes.js';
import { VARIANTS, extraLayoutTargets } from './variants.js';
import type { SettingsRoute } from './fixtures.js';
import type { ViewId } from './chains.js';

const BELOW_FLOOR = 280;

/**
 * The pages this run has (fixtureScope.ts writes only the views a scoped gate
 * selected; unset means all). A scoped run asserts its views, CI asserts every
 * one — the same selection the screenshots use.
 */
const AVAILABLE = new Set<ViewId>(fixtureViewsFromEnv(process.env).views);

/** The first registered layout target of a view (registration order, `skipLayout` excluded). */
function firstTargetVariant(view: ViewId): string {
  const target = extraLayoutTargets().find((t) => t.view === view);
  if (target === undefined) throw new Error(`pageFloor: ${view} has no layout target`);
  return target.variant.id;
}

/** The settings route variants carry a route; the first registered settings variant is the default page. */
function firstSettingsCase(): { readonly variant: string; readonly route: SettingsRoute } {
  const variant = VARIANTS.settings[0];
  const route = settingsRoutes()[0];
  if (variant === undefined || route === undefined) throw new Error('pageFloor: settings has no route variant');
  return {
    variant: variant.id,
    route: route.hash === undefined ? { section: route.section } : { section: route.section, hash: route.hash },
  };
}

interface FloorCase {
  readonly view: ViewId;
  readonly variant: string;
  readonly route?: SettingsRoute;
}

const settings = firstSettingsCase();

const EDITOR_CASES: readonly FloorCase[] = [
  { view: 'dashboard', variant: firstTargetVariant('dashboard') },
  { view: 'diffs', variant: firstTargetVariant('diffs') },
  { view: 'gettingStarted', variant: firstTargetVariant('gettingStarted') },
  { view: 'resources', variant: firstTargetVariant('resources') },
  { view: 'serverLogs', variant: firstTargetVariant('serverLogs') },
  { view: 'settings', variant: settings.variant, route: settings.route },
  { view: 'ticketForm', variant: firstTargetVariant('ticketForm') },
  { view: 'usage', variant: firstTargetVariant('usage') },
];

for (const target of EDITOR_CASES) {
  test(`${target.view}/page-floor-${BELOW_FLOOR}: keeps the ${PAGE_FLOOR} px page floor`, async ({ gotoView, page }) => {
    test.skip(!AVAILABLE.has(target.view), `${target.view} is out of this run's fixture scope`);
    await page.setViewportSize({ width: BELOW_FLOOR, height: LAYOUT_HEIGHT });
    await gotoView(
      target.view,
      target.route === undefined ? { variant: target.variant } : { variant: target.variant, route: target.route },
    );
    const root = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      width: document.documentElement.getBoundingClientRect().width,
    }));
    expect(root.width, `${target.view}: the document root collapsed below the page floor`).toBeGreaterThanOrEqual(
      PAGE_FLOOR,
    );
    expect(root.scrollWidth, `${target.view}: the page does not scroll to its floored width`).toBeGreaterThanOrEqual(
      PAGE_FLOOR,
    );
  });
}

test(`sidebar/page-floor-${BELOW_FLOOR}: keeps its own narrow layout and does not scroll (D860)`, async ({ gotoView, page }) => {
  test.skip(!AVAILABLE.has('sidebar'), 'sidebar is out of this run\'s fixture scope');
  await page.setViewportSize({ width: BELOW_FLOOR, height: LAYOUT_HEIGHT });
  await gotoView('sidebar', { variant: firstTargetVariant('sidebar') });
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollWidth, 'the sidebar opted out of the page floor but still scrolls sideways').toBeLessThanOrEqual(
    BELOW_FLOOR + 1,
  );
});
