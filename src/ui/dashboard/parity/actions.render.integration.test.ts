// @vitest-environment jsdom
/**
 * Dashboard parity oracle — every posting control (migration plan §3 A2, §5 Phase 1).
 *
 * Behavioural, not structural: each case builds a host state in which one
 * `[data-act]` control renders, clicks it through the DOM, and asserts the
 * EXACT messages posted to the host (type + payload, `requestId` present or
 * absent) plus the pending contract (aria-busy after the click, a repeat click
 * posts nothing). It must pass unchanged on the vanilla `webview.html` and on
 * its React replacement. The cases live in `parityCases.ts`; the source-reading
 * coverage guard is the unit test `coverage.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { renderWebviewReady } from '../../testing/renderHarness.js';
import { COVERED, q, clickEl, polyfillCss, isShown } from './parityCases.js';

// ---- the oracle -----------------------------------------------------------

describe('dashboard parity — click → posted message', () => {
  it.each(COVERED.map((c) => ({ ...c, id: c.variant ? `${c.act} (${c.variant})` : c.act })))('$id', async (c) => {
    const h = await renderWebviewReady('dashboard');
    try {
      polyfillCss(h);
      h.receive({ type: 'state', state: c.state() });
      await c.prep?.(h);
      const el = q(h, c.sel);
      expect(el, `control ${c.sel} did not render`).not.toBeNull();
      expect(isShown(el!), `control ${c.sel} is hidden`).toBe(true);

      const before = h.posted.length;
      clickEl(el!);
      const sent = h.posted.slice(before) as Array<Record<string, unknown>>;

      expect(sent.map(({ requestId: _r, ...rest }) => rest)).toEqual(c.posts);
      sent.forEach((m, i) => {
        // The first message of a requestId control carries the correlation id.
        const wantsId = c.rid === true && i === sent.length - 1;
        if (wantsId) expect(typeof m.requestId, `${String(m.type)} lacks requestId`).toBe('string');
        else expect('requestId' in m, `${String(m.type)} must not carry a requestId`).toBe(false);
      });
      expect(h.errors).toEqual([]);

      c.after?.(h);
      if (c.repeat) {
        // The control re-renders (a menu item): re-find it; a repeat is dropped.
        await c.prep?.(h);
        const n = h.posted.length;
        clickEl(q(h, c.sel)!);
        expect(h.posted.length, 'repeat click posted again').toBe(n);
      }
      if (c.posts.length === 0 || c.pendingSel === false) return;

      const pending = q(h, c.pendingSel ?? c.sel);
      expect(pending, `no pending marker at ${c.pendingSel ?? c.sel}`).not.toBeNull();
      expect(pending!.getAttribute('aria-busy')).toBe('true');
      const n = h.posted.length;
      clickEl(pending!);
      expect(h.posted.length, 'repeat click while pending posted again').toBe(n);
    } finally {
      h.close();
    }
  });
});
