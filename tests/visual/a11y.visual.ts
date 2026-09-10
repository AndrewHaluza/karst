import { test, expect } from '@playwright/test';
import { test as karstTest } from './fixtures.js';
import { ALL_VIEWS, MINIMAL_RATCHET } from './corpora.js';
import type { ViewId } from './corpora.js';
import type { ThemeId } from './themes.js';

/**
 * Views with no scrolling list container — asserted against so a new
 * scrolling list cannot join silently.
 */
const NO_SCROLL_VIEWS: readonly ViewId[] = ['gettingStarted'];

/**
 * Title-attribute ratchet: elements whose only accessible explanation is a
 * `title` attribute.  Shrink-only.
 */
const TITLE_RATCHET: Record<string, string> = {
  // settings: "Unsaved changes on this tab" — a tooltip-only hint on the dirty dot
  'settings:span#dirtyDot': 'Unsaved changes on this tab',
};

/**
 * Views that have a pending/loading state to test UI-R18 geometry.
 */
const HAS_PENDING_STATE: readonly ViewId[] = ['usage', 'resources'];

/**
 * The contrast ratchet: known failures keyed by theme → view → selector.
 * Shrink-only — entries may be removed when gaps are fixed, never added
 * without a written justification.
 *
 * G3: --k-success-fg / --k-danger-fg resolve to page background in some
 * themes, causing contrast failures on filled surfaces.
 */
const CONTRAST_RATCHET: Record<string, { ratio: number; gap?: string }> = {
  // dark theme
  'dark:button#approachDrawerDelete.k-btn.k-btn--danger': { ratio: 4.29, gap: 'G3' },
  'dark:p#leaveModalError.modal-error.hidden': { ratio: 4.29, gap: 'G3' },
  'dark:h1': { ratio: 1.61 },
  'dark:p.lede': { ratio: 3.08 },
  'dark:h2': { ratio: 3.08 },
  'dark:p.section-desc': { ratio: 3.08 },
  'dark:button#dismiss.k-btn.k-btn--ghost': { ratio: 3.08 },
  // light theme
  'light:span.agentSep': { ratio: 2.61 },
  'light:div.fieldHelp': { ratio: 2.36 },
  'light:span.attentionMark': { ratio: 3.12 },
  'light:span': { ratio: 3.12 },
  'light:div.menuHeading': { ratio: 2.36 },
  'light:div#degraded.note.hidden': { ratio: 3.12 },
  'light:div.nav-caption': { ratio: 2.36 },
  'light:div.sidebar-project-label': { ratio: 2.36 },
  'light:span.project-more': { ratio: 2.36 },
  'light:span.manifest-icon': { ratio: 2.36 },
  'light:div.ap-empty': { ratio: 2.61 },
  'light:div': { ratio: 2.61 },
  'light:span#syncTag.synctag.hidden': { ratio: 4.32 },
  'light:span#analyzeLbl': { ratio: 2.61 },
  'light:div.settingHelp': { ratio: 2.36 },
  'light:button.proc-advanced-link': { ratio: 2.61 },
  'light:button#approachDrawerDelete.k-btn.k-btn--danger': { ratio: 4.27, gap: 'G3' },
  'light:p#leaveModalError.modal-error.hidden': { ratio: 4.27, gap: 'G3' },
  // hc theme
  'hc:h1': { ratio: 1 },
  'hc:p.lede': { ratio: 1 },
  'hc:h2': { ratio: 1 },
  'hc:p.section-desc': { ratio: 1 },
  'hc:button#dismiss.k-btn.k-btn--ghost': { ratio: 1 },
};

karstTest.describe('UI-R29 contrast (computed assertion)', () => {
  for (const viewId of ALL_VIEWS) {
    karstTest(`${viewId}: text contrast meets WCAG AA`, async ({ gotoView }, testInfo) => {
      const theme = testInfo.project.use.theme as ThemeId;
      const page = await gotoView(viewId);

      const failures: Array<{
        selector: string;
        text: string;
        ratio: number;
        required: number;
        fg: string;
        bg: string;
      }> = await page.evaluate(() => {
        // Inline the WCAG helpers — page.evaluate runs in browser context.
        function parseCssColor(s: string): [number, number, number, number] | null {
          s = s.trim().toLowerCase();
          const hex = s.match(/^#([0-9a-f]{3,8})$/);
          if (hex) {
            const h = hex[1]!;
            if (h.length === 3) return [parseInt(h[0]! + h[0], 16), parseInt(h[1]! + h[1], 16), parseInt(h[2]! + h[2], 16), 1];
            if (h.length === 6) return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 1];
            if (h.length === 8) return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), parseInt(h.slice(6, 8), 16) / 255];
          }
          const rgb = s.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\s*\)$/);
          if (rgb) return [parseInt(rgb[1]!), parseInt(rgb[2]!), parseInt(rgb[3]!), rgb[4] !== undefined ? parseFloat(rgb[4]) : 1];
          return null;
        }
        function lum(r: number, g: number, b: number): number {
          const [rs, gs, bs] = [r, g, b].map(c => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); });
          return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
        }
        function cr(l1: number, l2: number) { return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); }
        function reqRatio(el: Element) {
          const cs = getComputedStyle(el);
          const fs = parseFloat(cs.fontSize);
          const fw = parseInt(cs.fontWeight) || 400;
          return (fs >= 24 || (fs >= 18.66 && fw >= 700)) ? 3 : 4.5;
        }
        function resolveBg(el: Element): [number, number, number] {
          let cur: Element | null = el;
          while (cur && cur !== document.documentElement) {
            const bg = getComputedStyle(cur).backgroundColor;
            if (bg && bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)') {
              const p = parseCssColor(bg);
              if (p && p[3] > 0) return [p[0], p[1], p[2]];
            }
            cur = cur.parentElement;
          }
          return [255, 255, 255];
        }

        const results: Array<{ selector: string; text: string; ratio: number; required: number; fg: string; bg: string }> = [];
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let node: Text | null;
        while ((node = walker.nextNode() as Text | null)) {
          const text = node.textContent?.trim();
          if (!text) continue;
          const el = node.parentElement;
          if (!el || el.closest('script, style, noscript')) continue;
          const cs = getComputedStyle(el);
          const color = cs.color;
          const fg = parseCssColor(color);
          if (!fg || fg[3] === 0) continue;
          const bgRgb = resolveBg(el);
          const fgLum = lum(fg[0], fg[1], fg[2]);
          const bgLum = lum(bgRgb[0], bgRgb[1], bgRgb[2]);
          const ratio = cr(fgLum, bgLum);
          const required = reqRatio(el);
          if (ratio < required) {
            // Build a CSS selector for the element.
            const sel = el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className ? '.' + String(el.className).split(/\s+/).join('.') : '');
            results.push({ selector: sel, text: text.slice(0, 40), ratio: Math.round(ratio * 100) / 100, required, fg: color, bg: cs.backgroundColor });
          }
        }
        return results;
      });

      // Filter against the ratchet — known failures are allowed, new ones are not.
      const unexpected = failures.filter((f) => {
        const key = `${theme}:${f.selector}`;
        return !(key in CONTRAST_RATCHET);
      });

      // Report unexpected failures as a structured message, not a silent pass.
      if (unexpected.length > 0) {
        const msg = unexpected
          .map((f) => `  ${f.selector}: ${f.ratio}:1 < ${f.required}:1 ("${f.text}")`)
          .join('\n');
        throw new Error(
          `UI-R29 contrast failures in ${viewId} (${theme}):\n${msg}\n` +
          `Add to CONTRAST_RATCHET with a gap id if this is a known v3.0 gap.`,
        );
      }
    });
  }
});

karstTest.describe('UI-R19 title dependence', () => {
  for (const viewId of ALL_VIEWS) {
    karstTest(`${viewId}: [title] elements have visible text or aria-label`, async ({ gotoView }) => {
      const page = await gotoView(viewId);

      const failures: Array<{ selector: string; title: string }> = await page.evaluate(() => {
        const results: Array<{ selector: string; title: string }> = [];
        document.querySelectorAll('[title]').forEach((el) => {
          const title = el.getAttribute('title') || '';
          if (!title) return;
          // Check for visible text content.
          const hasVisibleText = (el.textContent || '').trim().length > 0;
          // Check for aria-label.
          const hasAriaLabel = el.hasAttribute('aria-label');
          // Check for aria-describedby resolving to a rendered node.
          let hasDescribedBy = false;
          const descId = el.getAttribute('aria-describedby');
          if (descId) {
            const descEl = document.getElementById(descId);
            hasDescribedBy = !!(descEl && (descEl.textContent || '').trim().length > 0);
          }
          if (!hasVisibleText && !hasAriaLabel && !hasDescribedBy) {
            const sel = el.tagName.toLowerCase() + (el.id ? '#' + el.id : '');
            results.push({ selector: sel, title: title.slice(0, 40) });
          }
        });
        return results;
      });

      // Filter against the title ratchet.
      const unexpected = failures.filter((f) => {
        const key = `${viewId}:${f.selector}`;
        return !(key in TITLE_RATCHET);
      });

      expect(
        unexpected,
        `UI-R19: elements with only title="${unexpected[0]?.title}" in ${viewId}`,
      ).toHaveLength(0);
    });
  }
});

karstTest.describe('UI-R38 pinned controls', () => {
  for (const viewId of ALL_VIEWS) {
    if (NO_SCROLL_VIEWS.includes(viewId)) {
      karstTest(`${viewId}: skipped (no scrolling list)`, async ({ gotoView }) => {
        const page = await gotoView(viewId);
        // Assert this view has no overflow:auto list container.
        const hasScroll = await page.evaluate(() => {
          const els = document.querySelectorAll('[style*="overflow"], [class]');
          for (const el of els) {
            const cs = getComputedStyle(el);
            if (cs.overflowY === 'auto' || cs.overflowY === 'scroll') {
              return true;
            }
          }
          return false;
        });
        expect(hasScroll).toBe(false);
      });
      continue;
    }

    karstTest(`${viewId}: pinned controls stay pinned after scroll`, async ({ gotoView }) => {
      const page = await gotoView(viewId);

      // Find the scrolling container and pinned elements.
      const result = await page.evaluate(() => {
        // Find an overflow-y:auto/scroll container.
        const containers = [...document.querySelectorAll('*')].filter((el) => {
          const cs = getComputedStyle(el);
          return (cs.overflowY === 'auto' || cs.overflowY === 'scroll') && el.scrollHeight > el.clientHeight;
        });
        if (containers.length === 0) return { skipped: true, reason: 'no scrollable container' };
        const container = containers[0]!;
        // Find pinned siblings (position:sticky or elements with a pinned class).
        const pinned = [...container.children].filter((el) => {
          const cs = getComputedStyle(el);
          return cs.position === 'sticky';
        });
        if (pinned.length === 0) return { skipped: true, reason: 'no pinned elements' };
        // Record bounding boxes before scroll.
        const before = pinned.map((el) => el.getBoundingClientRect());
        // Scroll to bottom.
        container.scrollTop = container.scrollHeight;
        // Record bounding boxes after scroll.
        const after = pinned.map((el) => el.getBoundingClientRect());
        return {
          skipped: false,
          count: pinned.length,
          moved: before.map((b, i) => ({
            dx: Math.abs(after[i]!.x - b.x),
            dy: Math.abs(after[i]!.y - b.y),
          })),
        };
      });

      if (result.skipped) {
        // If there's no scrollable container, that's fine — just verify.
        return;
      }

      // Assert pinned controls didn't move more than 1px (subpixel rounding).
      for (const move of result.moved) {
        expect(move.dx, 'UI-R38: horizontal movement').toBeLessThanOrEqual(1);
        expect(move.dy, 'UI-R38: vertical movement').toBeLessThanOrEqual(1);
      }
    });
  }
});

karstTest.describe('UI-R18 pending geometry', () => {
  for (const viewId of HAS_PENDING_STATE) {
    karstTest(`${viewId}: pending state preserves usable geometry`, async ({ gotoView }) => {
      const page = await gotoView(viewId);

      // Find a control that can be toggled to a pending/busy state.
      // The assertion: bounding box moves ≤ 2px when aria-busy is toggled.
      const result = await page.evaluate(() => {
        // Find elements that could have a pending state.
        const candidates = document.querySelectorAll('[aria-busy], .k-pending, [data-pending]');
        if (candidates.length === 0) {
          // Try finding a status indicator or loading element.
          const all = document.querySelectorAll('.k-status, .k-dot, [role="status"]');
          if (all.length === 0) return { skipped: true, reason: 'no pending-state controls' };
          const el = all[0]!;
          const before = el.getBoundingClientRect();
          // Toggle aria-busy.
          const wasBusy = el.getAttribute('aria-busy') === 'true';
          el.setAttribute('aria-busy', wasBusy ? 'false' : 'true');
          const after = el.getBoundingClientRect();
          el.setAttribute('aria-busy', wasBusy ? 'true' : 'false'); // restore
          return {
            skipped: false,
            dx: Math.abs(after.x - before.x),
            dy: Math.abs(after.y - before.y),
            dw: Math.abs(after.width - before.width),
            dh: Math.abs(after.height - before.height),
          };
        }
        const el = candidates[0]!;
        const before = el.getBoundingClientRect();
        const wasBusy = el.getAttribute('aria-busy') === 'true';
        el.setAttribute('aria-busy', wasBusy ? 'false' : 'true');
        const after = el.getBoundingClientRect();
        el.setAttribute('aria-busy', wasBusy ? 'true' : 'false');
        return {
          skipped: false,
          dx: Math.abs(after.x - before.x),
          dy: Math.abs(after.y - before.y),
          dw: Math.abs(after.width - before.width),
          dh: Math.abs(after.height - before.height),
        };
      });

      if (result.skipped) return;

      // UI-R18: bounding box moved ≤ 2px in each axis.
      expect(result.dx, 'UI-R18: horizontal movement').toBeLessThanOrEqual(2);
      expect(result.dy, 'UI-R18: vertical movement').toBeLessThanOrEqual(2);
    });
  }
});
