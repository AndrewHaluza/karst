import { describe, expect, it } from 'vitest';
import { RING_CAPACITY } from '../../runtime/resourceMonitor.js';
import {
  resourcesRenderFixtures,
  RESOURCES_SCENARIOS,
} from './renderFixtures.js';

describe('resources render fixtures', () => {
  const fixtures = resourcesRenderFixtures();

  it('is deterministic: one fixture per scenario, no duplicates', () => {
    expect(fixtures).toHaveLength(RESOURCES_SCENARIOS.length);
    expect(new Set(fixtures.map((f) => f.scenario)).size).toBe(fixtures.length);
    expect(JSON.stringify(fixtures)).toBe(JSON.stringify(resourcesRenderFixtures()));
  });

  it('unsupported has supported === false and every other scenario true', () => {
    for (const f of fixtures) {
      expect(f.state.supported, f.scenario).toBe(f.scenario !== 'unsupported');
    }
  });

  it('wasteCount === waste.length', () => {
    for (const f of fixtures) {
      expect(f.state.wasteCount, f.scenario).toBe(f.state.waste.length);
    }
  });

  it('unattributedShown === unknown.length', () => {
    for (const f of fixtures) {
      expect(f.state.unattributedShown, f.scenario).toBe(f.state.unknown.length);
    }
  });

  it('busy history length equals historyMax', () => {
    const busy = fixtures.find((f) => f.scenario === 'busy')!;
    expect(busy.state.history.length).toBe(busy.state.historyMax);
  });

  it('every serverId in the reserved band 900001–999999 or null', () => {
    for (const f of fixtures) {
      for (const row of f.state.rows) {
        expect(row.pid, `${f.scenario} pid`).toBeGreaterThanOrEqual(900001);
      }
      for (const w of f.state.waste) {
        if (w.serverId !== null) {
          expect(w.serverId, `${f.scenario} waste serverId`).toBeGreaterThanOrEqual(900001);
        }
      }
    }
  });

  it('hostile contains the required untrusted strings', () => {
    const hostile = fixtures.find((f) => f.scenario === 'hostile')!;
    const allText = [
      ...hostile.state.rows.map((r) => `${r.label} ${r.ticketTitle}`),
      ...hostile.state.waste.map((w) => w.reason),
      ...hostile.state.facts.map((f) => `${f.label} ${f.value}`),
    ].join(' ');
    expect(allText).toContain('<script>alert(1)</script>');
    expect(allText).toContain('A & B "quoted" <b>');
  });
});
