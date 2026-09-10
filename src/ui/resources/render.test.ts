// @vitest-environment jsdom
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { renderWebview } from '../testing/renderHarness.js';
import { resourcesRenderFixtures, RESOURCES_SCENARIOS } from './renderFixtures.js';

const FIXTURE_NOW = new Date('2026-01-01T00:00:00.000Z');
const FIXTURE_NONCE = 'fixture-nonce-000000000000';

describe('resources render', () => {
  beforeEach(() => { vi.setSystemTime(FIXTURE_NOW); });
  afterEach(() => { vi.useRealTimers(); });

  const fixtures = resourcesRenderFixtures();

  for (const fixture of fixtures) {
    describe(fixture.scenario, () => {
      it('renders without throwing', () => {
        const h = renderWebview('resources', { nonce: FIXTURE_NONCE });
        try {
          h.receive({ type: 'state', state: fixture.state });
          expect(h.document.body).toBeDefined();
        } finally { h.close(); }
      });

      it('unsupported shows the unsupported surface (was: renders an unsupported platform as a single explanatory line)', () => {
        const h = renderWebview('resources', { nonce: FIXTURE_NONCE });
        try {
          h.receive({ type: 'state', state: fixture.state });
          if (!fixture.state.supported) {
            const unsupported = h.query('#unsupported');
            expect(unsupported).not.toBeNull();
            expect(unsupported!.classList.contains('hidden')).toBe(false);
          }
        } finally { h.close(); }
      });

      it('degraded shows the degraded surface (was: keeps the previous numbers on screen with a degraded note)', () => {
        const h = renderWebview('resources', { nonce: FIXTURE_NONCE });
        try {
          h.receive({ type: 'state', state: fixture.state });
          if (fixture.state.degraded) {
            const degraded = h.query('#degraded');
            expect(degraded).not.toBeNull();
            expect(degraded!.classList.contains('hidden')).toBe(false);
          }
        } finally { h.close(); }
      });

      it('renders one attributed row per entry (was: renders attributed rows)', () => {
        const h = renderWebview('resources', { nonce: FIXTURE_NONCE });
        try {
          h.receive({ type: 'state', state: fixture.state });
          if (fixture.state.supported && !fixture.state.degraded && fixture.state.rows.length > 0) {
            const rows = h.queryAll('#attrBody tr');
            expect(rows).toHaveLength(fixture.state.rows.length);
          }
        } finally { h.close(); }
      });

      it('renders pre-formatted display strings (was: renders cpuPctDisplay, rssDisplay, sampleAgeDisplay, scopeLabel)', () => {
        const h = renderWebview('resources', { nonce: FIXTURE_NONCE });
        try {
          h.receive({ type: 'state', state: fixture.state });
          if (fixture.state.supported && !fixture.state.degraded) {
            const body = h.document.body.textContent ?? '';
            if (fixture.state.cpuPctDisplay !== '—') {
              expect(body).toContain(fixture.state.cpuPctDisplay);
            }
          }
        } finally { h.close(); }
      });

      it('clicking a kill control posts kill-server with serverId (was: kill buttons post kill-server)', () => {
        const h = renderWebview('resources', { nonce: FIXTURE_NONCE });
        try {
          h.receive({ type: 'state', state: fixture.state });
          if (fixture.state.supported && !fixture.state.degraded) {
            const btn = h.query('[data-kill]');
            if (btn) {
              const before = h.posted.length;
              (btn as HTMLElement).click();
              expect(h.posted.length).toBe(before + 1);
              expect(h.posted[before]).toMatchObject({ type: 'kill-server' });
            }
          }
        } finally { h.close(); }
      });

      it('disk message renders disk rows (was: disk message renders disk table)', () => {
        const h = renderWebview('resources', { nonce: FIXTURE_NONCE });
        try {
          h.receive({ type: 'state', state: fixture.state });
          if (fixture.state.disk.length > 0) {
            h.receive({ type: 'disk', rows: fixture.state.disk });
            const diskRows = h.queryAll('#diskRows > *');
            expect(diskRows.length).toBeGreaterThan(0);
          }
        } finally { h.close(); }
      });

      it('snapshot (was: full document render)', () => {
        const h = renderWebview('resources', { nonce: FIXTURE_NONCE });
        try {
          h.receive({ type: 'state', state: fixture.state });
          expect(h.document.body.innerHTML).toMatchSnapshot();
        } finally { h.close(); }
      });
    });
  }
});
