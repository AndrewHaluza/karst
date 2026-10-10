import { test, expect } from '@playwright/test';
import { test as karstTest } from './fixtures.js';
import { ALL_VIEWS } from './corpora.js';
import type { ViewId } from './corpora.js';
import { formatAgentsHash } from '../../src/ui/settings/app/sections/agentsRoute.js';
import { COMPARE_PRESET, LONG_BODY_PROFILE } from './realisticSettings.js';

/**
 * Projects that take full-page screenshots (UI-R07 coverage).
 * The dark-grayscale, dark-reduced-motion, and catalog projects have their
 * own dedicated specs (status.visual.ts, catalog.visual.ts).
 */
const SCREENSHOT_PROJECTS = new Set(['dark', 'light', 'hc']);

/**
 * Full-page screenshot baselines for all nine webviews in three themes.
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
          if (!SCREENSHOT_PROJECTS.has(testInfo.project.name)) {
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
        if (!SCREENSHOT_PROJECTS.has(testInfo.project.name)) {
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

/**
 * The Agents settings page (D93), `realistic` scenario: roles, compare and a
 * profile. Baselines are container-authored and need the user's approval (D92).
 */
const AGENTS_SHOTS = [
  { name: 'agents-roles', hash: formatAgentsHash({ tab: 'roles' }) },
  { name: 'agents-compare', hash: formatAgentsHash({ tab: 'roles', compare: COMPARE_PRESET }) },
  { name: 'agents-profile', hash: formatAgentsHash({ tab: 'profiles', selected: LONG_BODY_PROFILE }) },
] as const;

karstTest.describe('agents page screenshots', () => {
  for (const shot of AGENTS_SHOTS) {
    karstTest(`${shot.name}: full-page screenshot`, async ({ gotoView, page }, testInfo) => {
      if (!SCREENSHOT_PROJECTS.has(testInfo.project.name)) {
        testInfo.skip();
        return;
      }
      await gotoView('settings', { scenario: 'realistic', route: { section: 'agents', hash: shot.hash } });
      await expect(page).toHaveScreenshot(`${shot.name}.png`, {
        fullPage: true,
        mask: [page.locator(TIME_MASKS)],
      });
    });
  }
});
