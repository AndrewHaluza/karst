/**
 * T820 — the Sub-tasks panel compacts by its own width (container queries), never by the window's, and never
 * overflows. The panel is pinned to each ladder tier's width in turn; at every tier nothing may scroll sideways and
 * the cells the ladder keeps (dot, lock, PR chip, pill) must still be laid out.
 */
import { test as karstTest, expect } from './fixtures.js';

const TIERS = [900, 720, 600, 460, 400, 320] as const;

/** Which optional cells are laid out (display not none) in the first row that has them. */
const SHOWN = `(() => {
  const vis = (sel) => { const el = document.querySelector(sel); return !!el && getComputedStyle(el).display !== 'none'; };
  return {
    key: vis('.subtask-key'), id: vis('.subtask .k-id'), age: vis('.subtask-age'), model: vis('.subtask-agent-model'),
    name: vis('.subtask-agent-name'), prState: vis('.subtask-pr-state'), progress: vis('.subtask-progress'),
    label: vis('#addSubtask .k-btn-label'),
    keep: ['.subtask .k-dot', '.subtask-lock', '.subtask-pr', '.subtask-agent svg', '.subtask .stage'].every(vis),
  };
})()`;

karstTest.describe('T820: Sub-tasks panel compaction ladder', () => {
  for (const width of TIERS) {
    karstTest(`${width}px: no horizontal overflow and the ladder holds`, async ({ gotoView, page }, testInfo) => {
      if (testInfo.project.name !== 'dark') {
        testInfo.skip();
        return;
      }
      await gotoView('dashboard', { variant: 'subtask-blocked' });
      await page.evaluate((w) => {
        const panel = document.getElementById('subtaskPanel') as HTMLElement;
        panel.style.width = `${w}px`;
        panel.style.maxWidth = `${w}px`;
      }, width);

      const overflow = await page.evaluate(() =>
        ['subtaskPanel', 'subtasks'].map((id) => {
          const el = document.getElementById(id)!;
          return el.scrollWidth - el.clientWidth;
        }),
      );
      expect(overflow, `${width}px panel scrolls sideways`).toEqual([0, 0]);

      const shown = (await page.evaluate(SHOWN)) as Record<string, boolean>;
      expect(shown.keep, 'dot, lock, PR chip, agent icon and pill never hide').toBe(true);
      expect(shown.model).toBe(width > 720);
      expect(shown.name).toBe(width > 600);
      expect(shown.id).toBe(width > 600);
      expect(shown.prState).toBe(width > 460);
      expect(shown.progress).toBe(width > 460);
      expect(shown.label).toBe(width > 460);
      expect(shown.key).toBe(width > 400);
      expect(shown.age).toBe(width > 400);
    });
  }
});
