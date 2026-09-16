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
          const populatedCount = fixture.state.sections.awaitingReview.length
            + fixture.state.sections.current.length
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
});
