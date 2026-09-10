import { describe, expect, it } from 'vitest';
import { USAGE_SORTS } from '../../store/tokenUsageQuery.js';
import {
  usageRenderFixtures,
  USAGE_SCENARIOS,
  type UsageScenario,
} from './renderFixtures.js';

/**
 * Data-contract tests for the usage render fixture corpus.
 * Pins deterministic identity, ordering, per-scenario invariants, vocabulary
 * coverage, hostile-string presence, and inert ids.
 */
describe('usage render fixtures', () => {
  const fixtures = usageRenderFixtures();

  it('is deterministic: one fixture per scenario, in USAGE_SCENARIOS order, no duplicates', () => {
    expect(fixtures).toHaveLength(USAGE_SCENARIOS.length);
    const ids = fixtures.map((f) => f.scenario);
    expect(ids).toEqual([...USAGE_SCENARIOS]);
    expect(new Set(ids).size).toBe(fixtures.length);
    expect(JSON.stringify(fixtures)).toBe(JSON.stringify(usageRenderFixtures()));
  });

  it('empty has empty === true and every row list length 0', () => {
    const empty = fixtures.find((f) => f.scenario === 'empty')!;
    expect(empty.state.empty).toBe(true);
    expect(empty.state.byStage).toHaveLength(0);
    expect(empty.state.byModel).toHaveLength(0);
    expect(empty.state.byProfile).toHaveLength(0);
    expect(empty.state.tickets).toHaveLength(0);
  });

  it('paged-middle has page.hasPrev && page.hasNext', () => {
    const mid = fixtures.find((f) => f.scenario === 'paged-middle')!;
    expect(mid.state.page.hasPrev).toBe(true);
    expect(mid.state.page.hasNext).toBe(true);
  });

  it('error has error !== null and every other scenario has error === null', () => {
    for (const f of fixtures) {
      if (f.scenario === 'error') {
        expect(f.state.error).not.toBeNull();
      } else {
        expect(f.state.error, f.scenario).toBeNull();
      }
    }
  });

  it('every UsageTicketRowView.ticketId is in the reserved band 900001–999999 or null', () => {
    for (const f of fixtures) {
      for (const t of f.state.tickets) {
        if (t.ticketId !== null) {
          expect(t.ticketId, `${f.scenario} ticket id`).toBeGreaterThanOrEqual(900001);
          expect(t.ticketId, `${f.scenario} ticket id`).toBeLessThanOrEqual(999999);
        }
      }
    }
  });

  it('all-sorts fixture carries every UsageSort member in its sorts array', () => {
    const allSorts = fixtures.find((f) => f.scenario === 'all-sorts')!;
    const sortIds = allSorts.state.sorts.map((s) => s.id);
    for (const key of USAGE_SORTS) {
      expect(sortIds, `missing sort: ${key}`).toContain(key);
    }
  });

  it('hostile contains the required untrusted strings and a >=300-char label', () => {
    const hostile = fixtures.find((f) => f.scenario === 'hostile')!;
    const allText = [
      ...hostile.state.byStage.map((r) => `${r.label} ${r.note ?? ''}`),
      ...hostile.state.byModel.map((r) => r.label),
      ...hostile.state.tickets.map((t) => t.label),
    ].join(' ');
    expect(allText).toContain('<script>alert(1)</script>');
    expect(allText).toContain('A & B "quoted" <b>');
    expect(allText.length).toBeGreaterThan(300);
  });

  it('calling the factory twice returns structurally equal but non-identical arrays', () => {
    const a = usageRenderFixtures();
    const b = usageRenderFixtures();
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a).not.toBe(b);
  });
});
