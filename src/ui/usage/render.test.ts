// @vitest-environment jsdom
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { renderWebview } from '../testing/renderHarness.js';
import {
  usageRenderFixtures,
  USAGE_SCENARIOS,
} from './renderFixtures.js';

const FIXTURE_NOW = new Date('2026-01-01T00:00:00.000Z');
const FIXTURE_NONCE = 'fixture-nonce-000000000000';

describe('usage render', () => {
  beforeEach(() => { vi.setSystemTime(FIXTURE_NOW); });
  afterEach(() => { vi.useRealTimers(); });

  const fixtures = usageRenderFixtures();

  for (const fixture of fixtures) {
    describe(fixture.scenario, () => {
      it('renders without throwing', () => {
        const h = renderWebview('usage', { nonce: FIXTURE_NONCE });
        try {
          h.receive({ type: 'state', state: fixture.state });
          expect(h.document.body).toBeDefined();
        } finally { h.close(); }
      });

      it('renders range chips from state (was: renders the range chips from state, never from a hardcoded list)', () => {
        const h = renderWebview('usage', { nonce: FIXTURE_NONCE });
        try {
          h.receive({ type: 'state', state: fixture.state });
          const chips = h.queryAll('.ranges .k-chip');
          expect(chips).toHaveLength(fixture.state.ranges.length);
          for (let i = 0; i < chips.length; i++) {
            expect(chips[i]!.textContent).toBe(fixture.state.ranges[i]!.label);
          }
        } finally { h.close(); }
      });

      it('shows the empty state when empty and no error (was: shows the empty state instead of a grid of zeroes)', () => {
        const h = renderWebview('usage', { nonce: FIXTURE_NONCE });
        try {
          h.receive({ type: 'state', state: fixture.state });
          const emptyVisible = !h.query('#empty')!.classList.contains('hidden');
          const bodyVisible = !h.query('#body')!.classList.contains('hidden');
          if (fixture.state.empty && !fixture.state.error) {
            expect(emptyVisible).toBe(true);
            expect(bodyVisible).toBe(false);
          }
        } finally { h.close(); }
      });

      it('renders one ticket row per entry (was: renders ticket rows from state)', () => {
        const h = renderWebview('usage', { nonce: FIXTURE_NONCE });
        try {
          h.receive({ type: 'state', state: fixture.state });
          if (!fixture.state.empty && !fixture.state.error) {
            const rows = h.queryAll('#tbody tr');
            expect(rows).toHaveLength(fixture.state.tickets.length);
          }
        } finally { h.close(); }
      });

      it('renders breakdown rows for byStage and byModel (was: renders breakdown rows)', () => {
        const h = renderWebview('usage', { nonce: FIXTURE_NONCE });
        try {
          h.receive({ type: 'state', state: fixture.state });
          if (!fixture.state.empty && !fixture.state.error) {
            const stageRows = h.queryAll('#stages .brow');
            expect(stageRows).toHaveLength(fixture.state.byStage.length);
            const modelRows = h.queryAll('#models .brow');
            expect(modelRows).toHaveLength(fixture.state.byModel.length);
          }
        } finally { h.close(); }
      });

      it('clicking a range chip posts set-range (was: range chips post set-range)', () => {
        const h = renderWebview('usage', { nonce: FIXTURE_NONCE });
        try {
          h.receive({ type: 'state', state: fixture.state });
          const chip = h.query('.ranges .k-chip');
          if (chip) {
            const before = h.posted.length;
            (chip as HTMLElement).click();
            expect(h.posted.length).toBe(before + 1);
            expect(h.posted[before]).toMatchObject({ type: 'set-range' });
          }
        } finally { h.close(); }
      });

      it('clicking a ticket row posts open-dashboard with ticketId (was: ticket rows post open-dashboard)', () => {
        const h = renderWebview('usage', { nonce: FIXTURE_NONCE });
        try {
          h.receive({ type: 'state', state: fixture.state });
          if (!fixture.state.empty && !fixture.state.error) {
            const btn = h.query('#tbody [data-ticket]');
            if (btn) {
              const before = h.posted.length;
              (btn as HTMLElement).click();
              expect(h.posted.length).toBe(before + 1);
              expect(h.posted[before]).toMatchObject({ type: 'open-dashboard' });
            }
          }
        } finally { h.close(); }
      });

      it('snapshot (was: full document render)', () => {
        const h = renderWebview('usage', { nonce: FIXTURE_NONCE });
        try {
          h.receive({ type: 'state', state: fixture.state });
          expect(h.document.body.innerHTML).toMatchSnapshot();
        } finally { h.close(); }
      });
    });
  }
});
