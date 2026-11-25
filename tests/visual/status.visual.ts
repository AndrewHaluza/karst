import { test as karstTest, expect } from './fixtures.js';

/**
 * Status/state surface screenshots for UI-R28 (grayscale) and UI-R30
 * (reduced motion).
 *
 * These baselines screen the DASHBOARD's running state, not a separate page:
 * any change to what the dashboard renders in the first viewport (panels, rows,
 * captions) re-records `status-primitives.png` in all three status projects. Do
 * not mistake such a diff for host churn.
 *
 * Run in the `dark`, `dark-grayscale`, and `dark-reduced-motion` projects
 * only — status primitives live in one place and do not need per-theme
 * baselines. FILE_PROJECTS in tests/visual/projectFilter.ts holds that list.
 *
 * The grayscale baseline (UI-R28) really is grayscale: the `dark-grayscale`
 * project adds `:root { filter: grayscale(1); }` after navigation and asserts the
 * computed filter, so the PNG cannot silently stay in colour. It is expected to
 * show G1's five identical `.k-dot` circles — that is the documented defect, not
 * a sweep failure.
 */

karstTest.describe('status/state screenshots', () => {
  karstTest('status primitives: full-page screenshot', async ({ gotoView, page }, testInfo) => {
    // Navigate to the dashboard — status primitives are most visible there.
    await gotoView('dashboard', { variant: 'populated' });

    // UI-R28: grayscale is applied to the loaded document, not by addInitScript —
    // that runs before `document.documentElement` exists, so the style never landed
    // and the "grayscale" baseline was a colour screenshot. CSP allows inline styles
    // (`style-src 'unsafe-inline'`, src/model/csp.ts), so addStyleTag works.
    if (testInfo.project.name === 'dark-grayscale') {
      await page.addStyleTag({ content: ':root { filter: grayscale(1); }' });
      await expect
        .poll(() => page.evaluate(() => getComputedStyle(document.documentElement).filter), {
          message: 'dark-grayscale must render with the UI-R28 grayscale filter applied',
        })
        .toContain('grayscale(1)');
    }

    await expect(page).toHaveScreenshot('status-primitives.png', {
      fullPage: false,
      mask: [page.locator('[data-karst-clock], .k-clock, [data-elapsed]')],
    });
  });
});
