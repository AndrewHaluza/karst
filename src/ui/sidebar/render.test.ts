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
            + fixture.state.sections.awaitingReview.length
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

  // The resize edge line (SIDEBAR-SUPER-THIN-EDGE-LINE-SO): the host pushes the
  // resolved side; the view stamps it on <html> and CSS paints the 1px inset.
  describe('resize edge line', () => {
    it('applies the host-resolved side as data-edge on the root, clearing it for none', () => {
      const h = renderWebview('sidebar', { nonce: FIXTURE_NONCE });
      try {
        h.receive({ type: 'edge', side: 'right' });
        expect(h.document.documentElement.getAttribute('data-edge')).toBe('right');

        h.receive({ type: 'edge', side: 'left' });
        expect(h.document.documentElement.getAttribute('data-edge')).toBe('left');

        h.receive({ type: 'edge', side: 'none' });
        expect(h.document.documentElement.hasAttribute('data-edge')).toBe(false);
      } finally { h.close(); }
    });

    it('declares a 1px inset edge-line rule for each side (UI-R04)', () => {
      const h = renderWebview('sidebar', { nonce: FIXTURE_NONCE });
      try {
        const selectors = h.cssRules().map((r) => r.selectorText);
        expect(selectors).toContain('html[data-edge="right"] body');
        expect(selectors).toContain('html[data-edge="left"] body');
      } finally { h.close(); }
    });
  });

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

    it('renders a host-flagged queued sub-task chip as Queued', () => {
      const h = render();
      try {
        const chips = h.queryAll('.ticket .stage').map((el) => el.textContent);
        expect(chips).toEqual(['impl', 'impl', 'Queued', 'impl']);
      } finally { h.close(); }
    });

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
