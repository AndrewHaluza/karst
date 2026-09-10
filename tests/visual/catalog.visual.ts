import { test, expect } from '@playwright/test';
import { test as karstTest } from './fixtures.js';

/**
 * Catalog page screenshot (D15).
 *
 * The catalog has its own hard-coded palette and cannot be themed.
 * It is baselined dark-only and labelled a documentation artefact,
 * not a proof of shipped rendering.
 *
 * This test runs ONLY in the `catalog` project.
 */

karstTest.describe('catalog page', () => {
  karstTest('catalog: full-page screenshot', async ({ page }, testInfo) => {
    if (testInfo.project.name !== 'catalog') {
      testInfo.skip();
      return;
    }
    await page.goto('/catalog.html', { waitUntil: 'load', timeout: 30_000 });
    // The catalog is a static HTML file — no seed script, no data-karst-ready.
    // Just wait for the page to settle.
    await page.waitForTimeout(500);
    await expect(page).toHaveScreenshot('catalog.png', {
      fullPage: true,
    });
  });
});
