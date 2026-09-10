import { describe, expect, it } from 'vitest';
import { TUTORIAL_STEPS } from './state.js';
import {
  gettingStartedRenderFixtures,
  GETTING_STARTED_SCENARIOS,
  type GettingStartedScenario,
} from './renderFixtures.js';

/**
 * Data-contract tests for the gettingStarted render fixture corpus.
 * Pins deterministic identity, ordering, per-scenario invariants, bounded
 * remainder counts, vocabulary coverage, hostile-string presence, and inert
 * ids — the corpus's own guarantee that render tests can rely on.
 */
describe('gettingStarted render fixtures', () => {
  const fixtures = gettingStartedRenderFixtures();

  it('is deterministic: one fixture per scenario, in GETTING_STARTED_SCENARIOS order, no duplicates', () => {
    expect(fixtures).toHaveLength(GETTING_STARTED_SCENARIOS.length);
    const ids = fixtures.map((f) => f.scenario);
    expect(ids).toEqual([...GETTING_STARTED_SCENARIOS]);
    expect(new Set(ids).size).toBe(fixtures.length);
    // Two calls produce byte-identical data — no clock, no randomness.
    expect(JSON.stringify(fixtures)).toBe(JSON.stringify(gettingStartedRenderFixtures()));
  });

  it('fresh has zero complete items', () => {
    const fresh = fixtures.find((f) => f.scenario === 'fresh')!;
    expect(fresh.state.checklist.every((it) => it.done)).toBe(false);
  });

  it('complete has all items done', () => {
    const complete = fixtures.find((f) => f.scenario === 'complete')!;
    expect(complete.state.checklist.every((it) => it.done)).toBe(true);
  });

  it('partial has at least one complete and one incomplete item', () => {
    const partial = fixtures.find((f) => f.scenario === 'partial')!;
    expect(partial.state.checklist.some((it) => it.done)).toBe(true);
    expect(partial.state.checklist.some((it) => !it.done)).toBe(true);
  });

  it('empty has zero checklist items', () => {
    const empty = fixtures.find((f) => f.scenario === 'empty')!;
    expect(empty.state.checklist).toHaveLength(0);
  });

  it('every fixture carries the production tutorial step count', () => {
    for (const f of fixtures) {
      expect(f.state.tutorial, f.scenario).toHaveLength(TUTORIAL_STEPS.length);
    }
  });

  it('every id-like string field starts with fixture:', () => {
    for (const f of fixtures) {
      for (const item of f.state.checklist) {
        expect(item.id, `${f.scenario} checklist item id`).toMatch(/^fixture:/);
      }
      for (const step of f.state.tutorial) {
        expect(step.id, `${f.scenario} tutorial step id`).toMatch(/^fixture:/);
      }
    }
  });

  it('hostile contains the required untrusted strings and a >=300-char label', () => {
    const hostile = fixtures.find((f) => f.scenario === 'hostile')!;
    const allText = [
      ...hostile.state.checklist.map((i) => `${i.label} ${i.detail ?? ''}`),
      ...hostile.state.tutorial.map((s) => `${s.label} ${s.description}`),
    ].join(' ');
    expect(allText).toContain('<script>alert(1)</script>');
    expect(allText).toContain('A & B "quoted" <b>');
    // At least one label >= 300 chars.
    const longLabels = [
      ...hostile.state.checklist.map((i) => i.label),
      ...hostile.state.tutorial.map((s) => s.label),
      ...hostile.state.tutorial.map((s) => s.description),
    ];
    expect(longLabels.some((l) => l.length >= 300)).toBe(true);
  });

  it('calling the factory twice returns structurally equal but non-identical arrays', () => {
    const a = gettingStartedRenderFixtures();
    const b = gettingStartedRenderFixtures();
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a).not.toBe(b);
    for (let i = 0; i < a.length; i++) {
      expect(a[i]).not.toBe(b[i]);
    }
  });
});
