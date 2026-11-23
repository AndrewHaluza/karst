/**
 * T1318 (SB-3) — the sidebar at its real width. The screenshots now record the ~300 px host width, so the geometry
 * the shots cannot state is checked here, against the same pages the sweep records (@ui:UI-R57):
 *
 * - no pane scrolls sideways at the 300 floor and the 320 step, with the Queue open too (@ui:UI-R43, RD-1);
 * - the stage pill's `::before` is the short key at 300 px and the full word at 460 px (@ui:UI-R49, @ui:UI-R51, SB-5);
 * - the open Activity body holds at least three rows at 700 px (SB-7, @ui:RD-TIERS);
 * - a cold start paints the skeleton and a thrown host build paints the error line, never the empty state
 *   (SB-2, @ui:UI-R46).
 */
import type { Page } from '@playwright/test';
import { test as karstTest, expect } from './fixtures.js';
import { VARIANTS } from './variants.js';

/** The two widths the shot set is floored at; 460 is the full-word tier the stage check opens. */
const SHORT_TIERS = [300, 320] as const;
const FULL_TIER = 460;
const HOST_HEIGHT = 700;

/** Every element that may scroll sideways: `.panes` and each open `.pane-body` (@ui:UI-R43). */
const OVERFLOW = `(() => {
  const els = [document.getElementById('panes'), ...document.querySelectorAll('.pane-body')];
  return els
    .filter(Boolean)
    .filter((el) => el.scrollWidth > el.clientWidth)
    .map((el) => (el.id || el.className) + ': ' + (el.scrollWidth - el.clientWidth) + 'px');
})()`;

/** The `::before` content of the first ticket's stage pill, with the quotes Chromium returns. */
const stageContent = (page: Page): Promise<string> =>
  page.locator('.ticket .stage[data-full]').first().evaluate((el) => getComputedStyle(el, '::before').content);

karstTest.describe('sidebar/real width', () => {
  for (const width of SHORT_TIERS) {
    karstTest(`${width}px: no pane scrolls sideways, even with the Queue open (RD-1)`, async ({ gotoView, page }) => {
      await page.setViewportSize({ width, height: HOST_HEIGHT });
      for (const variant of ['populated', 'populated-300', 'queue-chips-300'] as const) {
        await gotoView('sidebar', { variant });
        expect(await page.evaluate(OVERFLOW), `${width}px: ${variant}`).toEqual([]);
      }
    });
  }

  karstTest('the stage pill reads the short key at 300 px and the full word at 460 px (SB-5)', async ({ gotoView, page }) => {
    await page.setViewportSize({ width: 300, height: HOST_HEIGHT });
    await gotoView('sidebar', { variant: 'populated' });
    expect(await stageContent(page), 'the tight tier carries the stage key').toBe('"impl"');
    await page.setViewportSize({ width: FULL_TIER, height: HOST_HEIGHT });
    expect(await stageContent(page), 'the narrow tier carries the full stage word').toBe('"Implementation"');
  });

  karstTest('the open Activity body holds three rows at 700 px (SB-7)', async ({ gotoView, page }) => {
    await page.setViewportSize({ width: 300, height: HOST_HEIGHT });
    await gotoView('sidebar', { variant: 'populated-300' });
    const sizes = await page.evaluate(() => {
      const pane = document.querySelector('.pane[data-pane="activity"]');
      const body = pane?.querySelector('.pane-body');
      const row = body?.querySelector('.a-row');
      return {
        collapsed: pane?.getAttribute('data-collapsed') ?? null,
        body: body ? body.getBoundingClientRect().height : 0,
        row: row ? row.getBoundingClientRect().height : 0,
      };
    });
    expect(sizes.collapsed, 'the real 300 px page shows its Activity rows').toBe('false');
    expect(sizes.row, 'an Activity row is laid out').toBeGreaterThan(0);
    expect(sizes.body, 'the Activity body is at least three rows high').toBeGreaterThanOrEqual(sizes.row * 3);
  });

  karstTest('a cold start paints the skeleton, never the empty state (SB-2, @ui:UI-R46)', async ({ gotoView, page }) => {
    await page.setViewportSize({ width: 300, height: HOST_HEIGHT });
    await gotoView('sidebar', { variant: 'loading' });
    const loading = await page.evaluate(() => ({
      skeletons: document.querySelectorAll('.pane-skel').length,
      empty: document.querySelectorAll('.pane-empty').length,
      html: document.getElementById('panes')?.innerHTML ?? '',
    }));
    expect(loading.skeletons, 'the loaded layout, minus the data').toBeGreaterThan(0);
    expect(loading.empty, 'the loading page states no empty result').toBe(0);

    await gotoView('sidebar', { variant: 'empty' });
    const empty = await page.evaluate(() => ({
      skeletons: document.querySelectorAll('.pane-skel').length,
      html: document.getElementById('panes')?.innerHTML ?? '',
    }));
    expect(empty.skeletons, 'the empty page is not a skeleton').toBe(0);
    expect(empty.html, 'loading and empty are different pages').not.toBe(loading.html);
  });

  karstTest('every state glyph is a distinct shape, never hue alone (UI-R28, UI-R28b)', async ({ gotoView, page }) => {
    await page.setViewportSize({ width: 300, height: HOST_HEIGHT });
    await gotoView('sidebar', { variant: 'peek-states-300' });
    const markers = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.k-status')).map((el) =>
        el.classList.contains('k-status--running') ? 'spinner' : (el.textContent ?? '').trim(),
      ),
    );
    expect(new Set(markers).size, `the glyphs: ${markers.join(' ')}`).toBeGreaterThanOrEqual(5);
    expect(markers, 'the running state paints the spinner').toContain('spinner');
  });

  karstTest('a failed host build shows the error line over the skeleton (SB-2)', async ({ gotoView, page }) => {
    await page.setViewportSize({ width: 300, height: HOST_HEIGHT });
    await gotoView('sidebar', { variant: 'host-error' });
    // The page has no host behind it: replay the same error message the variant declares.
    for (const message of VARIANTS.sidebar.find((v) => v.id === 'host-error')?.replies ?? []) {
      await page.evaluate((data) => window.dispatchEvent(new MessageEvent('message', { data })), message);
    }
    await expect(page.locator('[data-sidebar-error="1"]')).toBeVisible();
    expect(await page.locator('.pane-skel').count(), 'a failed build is not an empty list').toBeGreaterThan(0);
  });
});
