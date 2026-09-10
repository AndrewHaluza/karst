import { test, expect } from '@playwright/test';
import { test as karstTest } from './fixtures.js';
import type { ThemeId } from './themes.js';

const STATUS_PROJECTS: readonly string[] = ['dark', 'dark-grayscale', 'dark-reduced-motion'];

/**
 * Status/state surface screenshots for UI-R28 (grayscale) and UI-R30
 * (reduced motion).
 *
 * Run in the `dark`, `dark-grayscale`, and `dark-reduced-motion` projects
 * only — status primitives live in one place and do not need per-theme
 * baselines.
 *
 * The grayscale baseline (UI-R28) is expected to show G1's five identical
 * `.k-dot` circles — that is the documented defect, not a sweep failure.
 */

/** Selectors for the status/state primitives. */
const STATUS_SELECTOR = '.k-dot, .k-status, [data-status], [data-state]';

karstTest.describe('status/state screenshots', () => {
  karstTest('status primitives: full-page screenshot', async ({ gotoView, page }, testInfo) => {
    if (!STATUS_PROJECTS.includes(testInfo.project.name)) {
      testInfo.skip();
      return;
    }
    // Navigate to the dashboard — status primitives are most visible there.
    await gotoView('dashboard', { scenario: 'running' });
    await expect(page).toHaveScreenshot('status-primitives.png', {
      fullPage: false,
      mask: [page.locator('[data-karst-clock], .k-clock, [data-elapsed]')],
    });
  });
});
