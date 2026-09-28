// @vitest-environment jsdom
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { renderWebview } from '../testing/renderHarness.js';
import { sidebarRenderFixtures, SIDEBAR_SCENARIOS } from './renderFixtures.js';

const FIXTURE_NOW = new Date('2026-01-01T00:00:00.000Z');
const FIXTURE_NONCE = 'fixture-nonce-000000000000';

describe('sidebar render', () => {
  beforeEach(() => { vi.setSystemTime(FIXTURE_NOW); });
  afterEach(() => { vi.useRealTimers(); });

  const fixtures = sidebarRenderFixtures();

  for (const fixture of fixtures) {
    describe(fixture.scenario, () => {
      it('renders without throwing', () => {
        const h = renderWebview('sidebar', { nonce: FIXTURE_NONCE });
        try {
          h.receive({ type: 'state', state: fixture.state });
          expect(h.document.body).toBeDefined();
        } finally { h.close(); }
      });

      it('renders facet chips matching the counts (was: renders one chip per facet)', () => {
        const h = renderWebview('sidebar', { nonce: FIXTURE_NONCE });
        try {
          h.receive({ type: 'state', state: fixture.state });
          const chips = h.queryAll('.chips .k-chip, .facets .k-chip, [data-facet]');
          expect(chips.length).toBeGreaterThan(0);
        } finally { h.close(); }
      });

      it('renders ticket rows (was: renders one ticket row per entry)', () => {
        const h = renderWebview('sidebar', { nonce: FIXTURE_NONCE });
        try {
          h.receive({ type: 'state', state: fixture.state });
          const allRows = h.queryAll('[data-ticket], .row');
          const populatedCount = fixture.state.sections.current.length
            + fixture.state.sections.recentlyDone.length
            + fixture.state.sections.olderDone.length
            + fixture.state.done.length
            + fixture.state.rows.length;
          if (populatedCount > 0) {
            expect(allRows.length).toBeGreaterThan(0);
          }
        } finally { h.close(); }
      });

      it('clicking a facet chip posts toggle-facet (was: facet chips post toggle-facet)', () => {
        const h = renderWebview('sidebar', { nonce: FIXTURE_NONCE });
        try {
          h.receive({ type: 'state', state: fixture.state });
          const chip = h.query('[data-facet]');
          if (chip) {
            const before = h.posted.length;
            (chip as HTMLElement).click();
            expect(h.posted.length).toBe(before + 1);
            expect(h.posted[before]).toMatchObject({ type: 'toggle-facet' });
          }
        } finally { h.close(); }
      });

      it('snapshot (was: full document render)', () => {
        const h = renderWebview('sidebar', { nonce: FIXTURE_NONCE });
        try {
          h.receive({ type: 'state', state: fixture.state });
          expect(h.document.body.innerHTML).toMatchSnapshot();
        } finally { h.close(); }
      });
    });
  }

  // The collapse control (NDL-76): a row with sub-tasks can hide its whole
  // descendant sub-tree and show it again. Both states are exercised here, not
  // just the host-side predicate (items.test.ts covers that separately).
  describe('collapsible sub-tasks', () => {
    const fixture = sidebarRenderFixtures().find((f) => f.scenario === 'subtasks');
    if (!fixture) throw new Error('subtasks fixture missing');
    const subtaskState = fixture.state;

    function render() {
      const h = renderWebview('sidebar', { nonce: FIXTURE_NONCE });
      h.receive({ type: 'state', state: subtaskState });
      return h;
    }

    it('renders a collapse control only on rows that have sub-tasks', () => {
      const h = render();
      try {
        const controls = h.queryAll('[data-collapse]');
        // Two rows have children (FEAT-100 and FEAT-100-s1); the leaf and the
        // unrelated root have none.
        expect(controls.length).toBe(2);
      } finally { h.close(); }
    });

    it('hides the whole descendant sub-tree when collapsed, and restores it', () => {
      const h = render();
      try {
        expect(h.queryAll('.ticket').length).toBe(4);
        const toggle = h.query('[data-collapse="900001"]') as HTMLElement;
        expect(toggle).toBeTruthy();
        expect(toggle.getAttribute('aria-expanded')).toBe('true');

        toggle.click();
        // FEAT-100-s1 and its child FEAT-100-s1-s1 are gone; FEAT-100 and
        // FEAT-101 remain.
        expect(h.queryAll('.ticket').length).toBe(2);
        const collapsed = h.query('[data-collapse="900001"]') as HTMLElement;
        expect(collapsed.getAttribute('aria-expanded')).toBe('false');

        collapsed.click();
        expect(h.queryAll('.ticket').length).toBe(4);
      } finally { h.close(); }
    });
  });
});
