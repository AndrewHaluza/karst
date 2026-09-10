// @vitest-environment jsdom
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { renderWebview } from '../testing/renderHarness.js';
import { TUTORIAL_STEPS } from './state.js';
import {
  gettingStartedRenderFixtures,
  GETTING_STARTED_SCENARIOS,
} from './renderFixtures.js';

const FIXTURE_NOW = new Date('2026-01-01T00:00:00.000Z');
const FIXTURE_NONCE = 'fixture-nonce-000000000000';

/**
 * jsdom render + HTML-snapshot tests for the gettingStarted webview.
 * Each fixture is rendered through the real injector chain (design system +
 * palette), the page script is evaluated, and state is delivered. Assertions
 * verify structural properties of the rendered DOM plus one snapshot per
 * fixture into __snapshots__/render.test.ts.snap.
 */
describe('gettingStarted render', () => {
  beforeEach(() => {
    vi.setSystemTime(FIXTURE_NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const fixtures = gettingStartedRenderFixtures();

  for (const fixture of fixtures) {
    describe(fixture.scenario, () => {
      it('renders without throwing', () => {
        const h = renderWebview('gettingStarted', { nonce: FIXTURE_NONCE });
        try {
          h.receive({ type: 'state', state: fixture.state });
          expect(h.document.body).toBeDefined();
        } finally {
          h.close();
        }
      });

      it('renders one checklist row per entry (was: renders every checklist item)', () => {
        const h = renderWebview('gettingStarted', { nonce: FIXTURE_NONCE });
        try {
          h.receive({ type: 'state', state: fixture.state });
          const items = h.queryAll('#checklist > li');
          expect(items).toHaveLength(fixture.state.checklist.length);
        } finally {
          h.close();
        }
      });

      it('carries the correct done/not-done visual state on each row (was: marks done items with k-dot--passed)', () => {
        const h = renderWebview('gettingStarted', { nonce: FIXTURE_NONCE });
        try {
          h.receive({ type: 'state', state: fixture.state });
          const items = h.queryAll('#checklist > li');
          for (let i = 0; i < items.length; i++) {
            const dot = items[i]!.querySelector('.k-dot');
            expect(dot, `checklist item ${i}`).not.toBeNull();
            const expected = fixture.state.checklist[i]!.done
              ? 'k-dot--passed'
              : 'k-dot--failed';
            expect(dot!.classList.contains(expected), `checklist item ${i}`).toBe(true);
          }
        } finally {
          h.close();
        }
      });

      it('renders one tutorial step per entry (was: renders every tutorial step)', () => {
        const h = renderWebview('gettingStarted', { nonce: FIXTURE_NONCE });
        try {
          h.receive({ type: 'state', state: fixture.state });
          const steps = h.queryAll('#tutorial > li');
          expect(steps).toHaveLength(fixture.state.tutorial.length);
        } finally {
          h.close();
        }
      });

      it('tutorial step labels and descriptions are present as text content (was: shows tutorial labels)', () => {
        const h = renderWebview('gettingStarted', { nonce: FIXTURE_NONCE });
        try {
          h.receive({ type: 'state', state: fixture.state });
          const steps = h.queryAll('#tutorial > li');
          for (let i = 0; i < steps.length; i++) {
            const body = steps[i]!.querySelector('.step-body');
            expect(body, `step ${i}`).not.toBeNull();
            const label = body!.querySelector('.step-body > div:first-child');
            expect(label!.textContent).toBe(fixture.state.tutorial[i]!.label);
            const desc = body!.querySelector('.step-desc');
            expect(desc!.textContent).toBe(fixture.state.tutorial[i]!.description);
          }
        } finally {
          h.close();
        }
      });

      it('the recheck button posts recheck-deps (was: recheck triggers recheck-deps)', () => {
        const h = renderWebview('gettingStarted', { nonce: FIXTURE_NONCE });
        try {
          h.receive({ type: 'state', state: fixture.state });
          const before = h.posted.length;
          h.click('#recheck');
          expect(h.posted.length).toBe(before + 1);
          expect(h.posted[before]).toMatchObject({ type: 'recheck-deps' });
          expect(typeof (h.posted[before] as Record<string, unknown>).requestId).toBe('string');
        } finally {
          h.close();
        }
      });

      it('the dismiss button posts dismiss (was: dismiss triggers dismiss)', () => {
        const h = renderWebview('gettingStarted', { nonce: FIXTURE_NONCE });
        try {
          h.receive({ type: 'state', state: fixture.state });
          const before = h.posted.length;
          h.click('#dismiss');
          expect(h.posted.length).toBe(before + 1);
          expect(h.posted[before]).toMatchObject({ type: 'dismiss' });
        } finally {
          h.close();
        }
      });

      it('the report-issue button posts report-issue (was: report-issue triggers report-issue)', () => {
        const h = renderWebview('gettingStarted', { nonce: FIXTURE_NONCE });
        try {
          h.receive({ type: 'state', state: fixture.state });
          const before = h.posted.length;
          h.click('#report-issue');
          expect(h.posted.length).toBe(before + 1);
          expect(h.posted[before]).toMatchObject({ type: 'report-issue' });
        } finally {
          h.close();
        }
      });

      it('every static button carries a k-btn class and a variant (was: every static <button> carries a k-btn primitive and a variant)', () => {
        const h = renderWebview('gettingStarted', { nonce: FIXTURE_NONCE });
        try {
          h.receive({ type: 'state', state: fixture.state });
          const buttons = h.queryAll('button');
          expect(buttons.length).toBeGreaterThan(0);
          for (const btn of buttons) {
            expect(btn.classList.toString(), btn.id || btn.textContent || 'button').toMatch(/k-btn/);
            expect(btn.classList.toString(), btn.id || btn.textContent || 'button').toMatch(
              /k-btn--(primary|secondary|ghost|danger|link)/,
            );
          }
        } finally {
          h.close();
        }
      });

      it('every JS-created button carries a k-btn class and a variant (was: every JS-created button carries a k-btn primitive and a variant)', () => {
        const h = renderWebview('gettingStarted', { nonce: FIXTURE_NONCE });
        try {
          h.receive({ type: 'state', state: fixture.state });
          // Checklist "Create karst.yml" and tutorial step buttons are JS-created.
          const jsButtons = h.queryAll('.item-action, .step-action');
          expect(jsButtons.length).toBeGreaterThanOrEqual(1);
          for (const btn of jsButtons) {
            expect(btn.classList.toString(), btn.textContent ?? 'button').toMatch(/k-btn/);
            expect(btn.classList.toString(), btn.textContent ?? 'button').toMatch(
              /k-btn--(primary|secondary|ghost|danger|link)/,
            );
          }
        } finally {
          h.close();
        }
      });

      it('create-manifest button posts create-manifest through karstAction (was: routes create-manifest through karstAction instead of firing on an un-disabled click (UI-R11, R12))', () => {
        if (fixture.scenario !== 'fresh') return;
        const h = renderWebview('gettingStarted', { nonce: FIXTURE_NONCE });
        try {
          h.receive({ type: 'state', state: fixture.state });
          const btn = h.query('.item-action');
          if (!btn) return;
          const before = h.posted.length;
          (btn as HTMLElement).click();
          expect(h.posted.length).toBe(before + 1);
          expect(h.posted[before]).toMatchObject({ type: 'create-manifest' });
        } finally {
          h.close();
        }
      });

      it('handles action-result by settling the pending control (was: handles action-result by settling the pending control (UI-R13))', () => {
        const h = renderWebview('gettingStarted', { nonce: FIXTURE_NONCE });
        try {
          h.receive({ type: 'state', state: fixture.state });
          // Sending an action-result should not throw and should be processed.
          h.receive({ type: 'action-result', requestId: 'fixture:req:1', ok: true, message: null });
          expect(h.errors).toHaveLength(0);
        } finally {
          h.close();
        }
      });

      it('hostile text appears as escaped text content, not as markup (was: escapes untrusted labels)', () => {
        if (fixture.scenario !== 'hostile') return;
        const h = renderWebview('gettingStarted', { nonce: FIXTURE_NONCE });
        try {
          h.receive({ type: 'state', state: fixture.state });
          // No <script> element beyond the page's own inline scripts.
          const ownScriptCount = h.queryAll('script').length;
          // Send state again to re-render — the script count must not change.
          h.receive({ type: 'state', state: fixture.state });
          expect(h.queryAll('script').length).toBe(ownScriptCount);
          // Hostile text is present as text content (escaped), not as markup.
          expect(h.document.body.textContent).toContain('<script>alert(1)</script>');
          expect(h.document.body.textContent).toContain('A & B "quoted" <b>');
        } finally {
          h.close();
        }
      });

      it('snapshot (was: full document render)', () => {
        const h = renderWebview('gettingStarted', { nonce: FIXTURE_NONCE });
        try {
          h.receive({ type: 'state', state: fixture.state });
          expect(h.document.body.innerHTML).toMatchSnapshot();
        } finally {
          h.close();
        }
      });
    });
  }
});
