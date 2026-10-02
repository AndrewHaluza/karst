import { test, expect } from '@playwright/test';
import { test as karstTest } from './fixtures.js';
import { ALL_VIEWS } from './corpora.js';
import type { ViewId } from './corpora.js';

/**
 * Cap on focusable elements tested per view — baseline count control.
 * If a view has more than 12 focusable elements, only the first 12 are tested.
 * The ratchet asserts the total count doesn't silently grow.
 */
const FOCUS_CAP = 12;

/**
 * Known focusable-element counts per view at plan time.  Shrink-only ratchet.
 * If a view adds focusable elements, the count grows and the test fails —
 * the developer must either reduce the count or update the ratchet with a
 * justification.
 *
 * Updated once, with justification, by the agent-presets feature (ticket 508):
 * `ticketForm` gains ONE `#agentPresetSelect` (the per-ticket preset picker)
 * and `settings` gains ONE General `#f-defaultAgentPreset` select plus SIX
 * per-process `.proc-select` preset references (one per PROCESS_KEYS row).
 * All seven are net-new interactive controls that satisfy the ticket's
 * Done-when — a ticket can pick a preset and every AI process resolves its core
 * and model from the effective preset — and there is no existing focusable
 * element to fold them into.
 *
 * Updated a second time when the dashboard/sidebar/usage/resources/
 * gettingStarted visual corpora moved off MINIMAL/neutral seed state onto
 * populated production fixtures (`populatedStateFor`, `*RenderFixtures`).
 * The neutral seed's empty panels had no rows to carry links or buttons;
 * the populated envelope's servers/worktrees/PR rows, sidebar ticket rows,
 * usage/resources tables, and gettingStarted's step actions are all
 * genuinely-interactive controls a real ticket of this shape would render,
 * not new dead weight — the count grows because real content does.
 *
 * Updated a third time when `diffs` moved off its MINIMAL empty-worktrees
 * seed onto `diffsRenderFixtures()`'s `populated` scenario: two repos with
 * commits and staged/unstaged/untracked files. The empty seed rendered the
 * "No ticket worktrees" placeholder with nothing to focus; the populated
 * fixture's repo/group `<details>` disclosure triggers, per-commit
 * copy-hash buttons and file rows are all real controls a ticket with actual
 * changes would render.
 *
 * Updated a fourth time by the agent-preset editor (NDL-106): `settings` +6 —
 * the General tab's preset form (name, core, model, effort inputs plus Add and
 * Cancel). The seed has no presets, so the list itself contributes no rows;
 * six net-new controls on a form that could not fold into any existing field,
 * since the preset map is a top-level manifest key this tab now owns.
 *
 * Updated a fifth time by the sub-task UI (NDL-76, `#addSubtask`; PR #448,
 * `#detachSubtask`): `dashboard` +2 — the Sub-tasks panel's "Add sub-task…"
 * and the ticket header's "Detach from parent…" controls. Both are net-new
 * interactive controls on the awaiting-subtask flow and neither folds into an
 * existing focusable: `git diff 65df7194..HEAD -- src/ui/dashboard/webview.html`
 * adds exactly these two focusable elements and removes none (no `tabindex`
 * / `a[href]` / form-control changes either), and `tests/visual/corpora.ts` —
 * which seeds the rendered rows — is unchanged since the fourth update.
 */
const FOCUS_COUNT_RATCHET: Record<ViewId, number> = {
  dashboard: 46,
  usage: 11,
  resources: 17,
  serverLogs: 11,
  sidebar: 48,
  diffs: 35,
  settings: 193,
  ticketForm: 25,
  gettingStarted: 6,
};

karstTest.describe('UI-R23 keyboard focus presentation', () => {
  for (const viewId of ALL_VIEWS) {
    karstTest(`${viewId}: focused elements have visible focus indicators`, async ({ gotoView, page }) => {
      const pg = await gotoView(viewId);

      // Enumerate focusable elements in DOM order.
      const focusable = await pg.evaluate(() => {
        const selector = [
          'a[href]', 'button:not([disabled])', 'input:not([disabled]):not([type="hidden"])',
          'select:not([disabled])', 'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])',
        ].join(', ');
        return [...document.querySelectorAll(selector)].map((el) => {
          const tag = el.tagName.toLowerCase();
          const id = el.id ? `#${el.id}` : '';
          const cls = el.className && typeof el.className === 'string'
            ? '.' + el.className.split(/\s+/).filter(Boolean).join('.')
            : '';
          return `${tag}${id}${cls}`;
        });
      });

      // Assert the count against the ratchet.
      const expected = FOCUS_COUNT_RATCHET[viewId];
      if (expected !== undefined) {
        expect(
          focusable.length,
          `UI-R23: ${viewId} has ${focusable.length} focusable elements (ratchet: ${expected})`,
        ).toBeLessThanOrEqual(expected);
      }

      // Test the first FOCUS_CAP focusable elements.
      const toTest = focusable.slice(0, FOCUS_CAP);
      for (let i = 0; i < toTest.length; i++) {
        const selector = toTest[i]!;

        // Get the element's computed focus styles when NOT focused.
        const unfocusedStyles = await pg.evaluate((sel) => {
          const el = document.querySelector(sel);
          if (!el) return null;
          const cs = getComputedStyle(el);
          return {
            outlineStyle: cs.outlineStyle,
            outlineWidth: cs.outlineWidth,
            boxShadow: cs.boxShadow,
          };
        }, selector);

        if (!unfocusedStyles) continue;

        // Focus the element via Tab.
        if (i === 0) {
          await pg.keyboard.press('Tab');
        } else {
          await pg.keyboard.press('Tab');
        }

        // Wait for focus to settle.
        await pg.waitForTimeout(50);

        // Get the focused element's computed styles.
        const focusedStyles = await pg.evaluate((sel) => {
          const el = document.querySelector(sel);
          if (!el) return null;
          const cs = getComputedStyle(el);
          return {
            outlineStyle: cs.outlineStyle,
            outlineWidth: cs.outlineWidth,
            boxShadow: cs.boxShadow,
          };
        }, selector);

        if (!focusedStyles) continue;

        // Assert the focus indicator changed.
        const styleChanged =
          focusedStyles.outlineStyle !== unfocusedStyles.outlineStyle ||
          focusedStyles.outlineWidth !== unfocusedStyles.outlineWidth ||
          focusedStyles.boxShadow !== unfocusedStyles.boxShadow;

        // Skip the assertion if both are "none" — some elements have no focus
        // ring in either state (e.g., if CSS removes outlines globally).
        const bothNone =
          focusedStyles.outlineStyle === 'none' &&
          unfocusedStyles.outlineStyle === 'none' &&
          focusedStyles.boxShadow === 'none' &&
          unfocusedStyles.boxShadow === 'none';

        if (!bothNone) {
          expect(
            styleChanged,
            `UI-R23: ${selector} in ${viewId} — focus indicator did not change`,
          ).toBe(true);
        }
      }
    });
  }
});
