/**
 * Typed Playwright fixture for the visual sweep.
 *
 * Exposes:
 * - `theme`: the ThemeId from the project's `use.theme`
 * - `gotoView(view, { variant })`: navigates to `/<theme>/<view>--<variant>.html`, waits for
 *   `[data-karst-ready]` (throws after 5 s) and for the next animation frame.
 */
import { test as base, expect, type Page } from '@playwright/test';
import { fixtureThemeOf, type ThemeId } from './themes.js';
import type { ViewId } from './chains.js';
import { fixtureFile } from './variants.js';
import { missingFixtureMessage } from './fixtureScope.js';
import { SECTION_LABELS, type SettingsSection } from '../../src/ui/settings/sections.js';
import { FIXTURE_NOW_MS } from '../../src/ui/dashboard/renderFixtures.js';

/** A settings route: the outer nav section, plus an optional in-page hash. */
export interface SettingsRoute {
  section: SettingsSection;
  hash?: string;
  /** A selector scrolled into view before the shot (the pane scrolls inside a fixed viewport). */
  scrollTo?: string;
}

interface GotoOpts {
  /** A registered variant id (tests/visual/variants.ts); DEFAULT_VARIANT names the default page of a view. */
  variant: string;
  route?: SettingsRoute;
}

interface KarstFixtures {
  theme: ThemeId;
  gotoView: (view: ViewId, opts: GotoOpts) => Promise<Page>;
}

/**
 * Click the settings nav entry for `route.section`, then (if given) assign the
 * in-page hash. The outer section is not hash-driven, so there is no deep link.
 */
async function openRoute(page: Page, route: SettingsRoute): Promise<void> {
  // SET-13 gives a dirty or faulty tab an sr-only suffix (", unsaved changes" / ", has an error"),
  // so the accessible name is the label plus an optional suffix — match the label as a prefix.
  // The suffix appends after a text node, so the computed name keeps a space before the comma.
  const label = SECTION_LABELS[route.section].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  await page
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('button', { name: new RegExp(`^${label}\\s*(?:,|$)`) })
    .click();
  if (route.hash !== undefined) {
    await page.evaluate((hash) => {
      window.location.hash = hash;
    }, route.hash);
  }
  if (route.scrollTo !== undefined) {
    await page.locator(route.scrollTo).first().scrollIntoViewIfNeeded();
  }
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => done())));
  await page.waitForLoadState('networkidle');
}

/**
 * The dashboard reads `Date.now()` for its relative ages (Sub-tasks `14h ago`,
 * PR `opened 2 days ago`) against fixed fixture stamps, so an unpinned clock
 * drifts every dashboard baseline as the day moves. Pinned for dashboard pages.
 * The fixture stamps age from the same instant (`FIXTURE_NOW_MS`, T1357).
 */
const DASHBOARD_NOW = new Date(FIXTURE_NOW_MS);

/** How long `gotoView` waits for the page's seed script to mark `<html data-karst-ready>`. */
const READY_TIMEOUT_MS = 5000;

export const test = base.extend<KarstFixtures>({
  theme: async ({}, use, testInfo) => {
    // Theme is derived from the project name (e.g., 'dark', 'light', 'hc',
    // 'dark-grayscale', 'dark-reduced-motion', 'catalog').
    // The base theme is the first part before any hyphen.
    await use(fixtureThemeOf(testInfo.project.name));
  },

  gotoView: async ({ page, theme }, use) => {
    const goto = async (view: ViewId, opts: GotoOpts) => {
      if (view === 'dashboard') await page.clock.setFixedTime(DASHBOARD_NOW);
      const path = `/${theme}/${fixtureFile(view, opts.variant)}`;
      const fullUrl = new URL(path, 'http://127.0.0.1:4317').toString();
      const response = await page.goto(fullUrl, { waitUntil: 'load', timeout: 60_000 });
      // A page that the fixture writer did not write fails here, not as a silent wait and a screenshot diff.
      const missing = missingFixtureMessage({ path, status: response?.status() ?? null, env: process.env });
      if (missing !== null) throw new Error(missing);
      // The seed script sets data-karst-ready on <html> after dispatching messages.
      // Wait for it and throw on timeout: a page that never becomes ready must fail
      // here, not record a screenshot of a half-rendered page.
      await page.locator('[data-karst-ready]').waitFor({ state: 'attached', timeout: READY_TIMEOUT_MS });
      await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => done())));
      if (opts.route !== undefined) await openRoute(page, opts.route);
      return page;
    };
    await use(goto);
  },
});

export { expect };
