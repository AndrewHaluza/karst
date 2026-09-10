import { describe, expect, it } from 'vitest';
import { FACETS, type FacetKey } from './facets.js';
import { sidebarRenderFixtures, SIDEBAR_SCENARIOS } from './renderFixtures.js';

describe('sidebar render fixtures', () => {
  const fixtures = sidebarRenderFixtures();

  it('is deterministic: one fixture per scenario, no duplicates', () => {
    expect(fixtures).toHaveLength(SIDEBAR_SCENARIOS.length);
    expect(new Set(fixtures.map((f) => f.scenario)).size).toBe(fixtures.length);
    expect(JSON.stringify(fixtures)).toBe(JSON.stringify(sidebarRenderFixtures()));
  });

  it('empty has no populated lists', () => {
    const empty = fixtures.find((f) => f.scenario === 'empty')!;
    expect(empty.state.sections.current).toHaveLength(0);
    expect(empty.state.sections.recentlyDone).toHaveLength(0);
    expect(empty.state.sections.olderDone).toHaveLength(0);
    expect(empty.state.done).toHaveLength(0);
    expect(empty.state.rows).toHaveLength(0);
  });

  it('exactly one of sections/done/rows is non-empty per fixture (except empty)', () => {
    for (const f of fixtures) {
      if (f.scenario === 'empty') continue;
      const populated = [
        f.state.sections.current.length > 0 || f.state.sections.recentlyDone.length > 0 || f.state.sections.olderDone.length > 0,
        f.state.done.length > 0,
        f.state.rows.length > 0,
      ].filter(Boolean).length;
      expect(populated, f.scenario).toBe(1);
    }
  });

  it('counts has a key for every FacetKey', () => {
    for (const f of fixtures) {
      for (const key of FACETS.map((fac) => fac.key)) {
        expect(f.state.counts, `${f.scenario} missing ${key}`).toHaveProperty(key);
      }
    }
  });

  it('facets is never a bare empty array', () => {
    for (const f of fixtures) {
      expect(f.state.facets.length, f.scenario).toBeGreaterThan(0);
    }
  });

  it('every ticket id is in the reserved band', () => {
    for (const f of fixtures) {
      const allRows = [...f.state.sections.current, ...f.state.sections.recentlyDone, ...f.state.sections.olderDone, ...f.state.done, ...f.state.rows];
      for (const row of allRows) {
        expect(row.ticketId, `${f.scenario} ticket id`).toBeGreaterThanOrEqual(900001);
      }
    }
  });

  it('hostile contains the required untrusted strings', () => {
    const hostile = fixtures.find((f) => f.scenario === 'hostile')!;
    const allText = hostile.state.sections.current.map((r) => `${r.label} ${r.description} ${r.peek.title}`).join(' ');
    expect(allText).toContain('<script>alert(1)</script>');
    expect(allText.length).toBeGreaterThan(300);
  });
});
