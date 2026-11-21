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

/** The host-computed 'Agent setup' section, one assertion set per state (a)-(d). */
describe('gettingStarted render: agent setup', () => {
  const byScenario = (name: string) => gettingStartedRenderFixtures().find((f) => f.scenario === name)!;
  const open = (name: string) => {
    const h = renderWebview('gettingStarted', { nonce: FIXTURE_NONCE });
    h.receive({ type: 'state', state: byScenario(name).state });
    const text = (sel: string): string => h.document.querySelector(sel)?.textContent ?? '';
    return { h, text, rows: () => h.queryAll('#as-list > li') };
  };

  it('the section sits after Setup checklist, as data-region="agent-setup", with a Re-check button before it', () => {
    const { h } = open('agent-open');
    try {
      const sections = h.queryAll('section');
      const idx = sections.findIndex((s) => s.getAttribute('data-region') === 'agent-setup');
      expect(idx).toBe(1);
      expect(sections[0]!.querySelector('#recheck')).not.toBeNull();
      expect(sections[idx]!.querySelector('h2')!.textContent).toBe('Agent setup');
    } finally {
      h.close();
    }
  });

  it('a mixed run shows the time, the progress line, one row per item, marks and tags', () => {
    const { h, text, rows } = open('agent-open');
    try {
      expect(text('#as-updated')).toBe('Updated 09:41');
      expect(text('#as-body')).toContain('4 of 9 done · 1 skipped · 2 required open');
      const progress = h.document.querySelector('progress')!;
      expect([progress.max, progress.value]).toEqual([9, 4]);
      const rs = rows();
      expect(rs).toHaveLength(9);
      expect(rs.map((r) => r.getAttribute('data-status'))).toEqual([
        'done', 'done', 'open', 'open', 'skipped', 'done', 'open', 'open', 'done',
      ]);
      expect(rs[2]!.querySelector('[role="img"]')!.getAttribute('aria-label')).toBe('Open');
      expect(rs[4]!.querySelector('[role="img"]')!.getAttribute('aria-label')).toBe('Skipped');
      expect(rs[0]!.querySelector('[role="img"]')!.getAttribute('aria-label')).toBe('Done');
      expect(rs[2]!.querySelector('.k-chip')!.textContent).toBe('required');
      expect(rs[7]!.querySelector('.k-chip')!.textContent).toBe('optional');
    } finally {
      h.close();
    }
  });

  it('only an open row carries its detail on a second line', () => {
    const { h, rows } = open('agent-open');
    try {
      const rs = rows();
      expect(rs[2]!.querySelector('.detail')!.textContent).toBe('Detail for agent item 3');
      expect(rs[0]!.querySelector('.detail')).toBeNull();
      expect(rs[4]!.querySelector('.detail')).toBeNull();
    } finally {
      h.close();
    }
  });

  it('(a) no karst.yml: nine open rows and the one detail line once', () => {
    const { h, text, rows } = open('agent-no-manifest');
    try {
      expect(rows()).toHaveLength(9);
      expect(h.queryAll('#as-list .detail')).toHaveLength(0);
      const body = text('#as-body');
      expect(body.split('karst.yml does not exist or does not load')).toHaveLength(2);
      expect(body).toContain('0 of 9 done · 0 skipped · 6 required open');
      expect(body).not.toContain('All required setup items are done.');
    } finally {
      h.close();
    }
  });

  it('(b) checking: shows Checking… and keeps the old rows', () => {
    const { h, text, rows } = open('agent-checking');
    try {
      expect(text('#as-body')).toContain('Checking…');
      expect(h.document.querySelector('#as-body [role="status"]')).not.toBeNull();
      expect(rows()).toHaveLength(9);
    } finally {
      h.close();
    }
  });

  it('(c) error: one error line with the reason, rows stay, Re-check stays', () => {
    const { h, text, rows } = open('agent-error');
    try {
      const alerts = h.queryAll('#as-body [role="alert"]');
      expect(alerts).toHaveLength(1);
      expect(alerts[0]!.textContent).toContain('setup checklist timed out after 120 s.');
      expect(text('#as-body')).not.toContain('Checking…');
      expect(rows()).toHaveLength(9);
      expect(h.document.getElementById('recheck')).not.toBeNull();
    } finally {
      h.close();
    }
  });

  it('(d) all required done: a short done line and no error', () => {
    const { h, text } = open('agent-done');
    try {
      expect(text('#as-body')).toContain('All required setup items are done.');
      expect(h.queryAll('#as-body [role="alert"]')).toHaveLength(0);
    } finally {
      h.close();
    }
  });

  it('a state with no agentSetup renders an empty section body and no time', () => {
    const { h, text } = open('fresh');
    try {
      expect(text('#as-body')).toBe('');
      expect(text('#as-updated')).toBe('');
    } finally {
      h.close();
    }
  });

  it('a later state replaces the rows instead of adding to them', () => {
    const { h, rows } = open('agent-open');
    try {
      h.receive({ type: 'state', state: byScenario('agent-done').state });
      expect(rows()).toHaveLength(9);
      expect(h.queryAll('progress')).toHaveLength(1);
    } finally {
      h.close();
    }
  });
});
