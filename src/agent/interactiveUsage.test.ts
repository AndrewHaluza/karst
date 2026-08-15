import { describe, it, expect } from 'vitest';
import {
  interactiveUsageDelta,
  hasCounterDecrease,
  normalizeInteractiveUsage,
  type SampleCounts,
} from './interactiveUsage.js';

describe('interactiveUsageDelta', () => {
  it('subtracts the preceding cumulative sample', () => {
    expect(
      interactiveUsageDelta(
        { input: 1_000, output: 200, cacheRead: 100, cacheWrite: 20, total: 1_320 },
        { input: 1_450, output: 320, cacheRead: 180, cacheWrite: 40, total: 1_990 },
      ),
    ).toEqual({ input: 450, output: 120, reasoning: 0, cacheRead: 80, cacheWrite: 20, total: 670 });
  });

  it('treats an absent cache counter as zero — cache reads and writes never collapse', () => {
    expect(
      interactiveUsageDelta(
        { input: 100, output: 10 },
        { input: 300, output: 40, cacheRead: 50, cacheWrite: 5 },
      ),
    ).toEqual({ input: 200, output: 30, reasoning: 0, cacheRead: 50, cacheWrite: 5, total: 285 });
  });

  it('keeps the provider-reported total when both sides report one', () => {
    expect(
      interactiveUsageDelta(
        { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 999 },
        { input: 20, output: 7, cacheRead: 0, cacheWrite: 0, total: 2_200 },
      ),
    ).toEqual({ input: 10, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 1_201 });
  });

  it('derives a missing total from the four counters, like the token-usage semantics', () => {
    // prev: 100+10+0+0 = 110; next: 300+40+50+5 = 395; delta total 285.
    const next = interactiveUsageDelta(
      { input: 100, output: 10 },
      { input: 300, output: 40, cacheRead: 50, cacheWrite: 5 },
    );
    expect(next.total).toBe(285);
  });

  it('repeated identical cumulative samples yield a zero delta', () => {
    const sample: SampleCounts = { input: 50, output: 5, cacheRead: 10, cacheWrite: 1, total: 66 };
    expect(interactiveUsageDelta(sample, sample)).toEqual({
      input: 0,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    });
  });

  it('subtracts reasoning tokens as their own counter', () => {
    expect(
      interactiveUsageDelta(
        { input: 100, output: 10, reasoning: 400 },
        { input: 120, output: 15, reasoning: 900 },
      ).reasoning,
    ).toBe(500);
  });

  it('derives a missing total including reasoning — output-billed spend is not free', () => {
    // 300 + 40 + 900 reasoning + 50 + 5 = 1_295, less the prior 100+10+400 = 510.
    expect(
      interactiveUsageDelta(
        { input: 100, output: 10, reasoning: 400 },
        { input: 300, output: 40, reasoning: 900, cacheRead: 50, cacheWrite: 5 },
      ).total,
    ).toBe(785);
  });

  it('reports a reasoning decrease as a reset signal', () => {
    expect(
      hasCounterDecrease(
        { input: 100, output: 10, reasoning: 900 },
        { input: 120, output: 15, reasoning: 400 },
      ),
    ).toBe(true);
  });

  it('reports a decrease in any counter as a reset signal', () => {
    const prev = { input: 1_000, output: 200, cacheRead: 100, cacheWrite: 20, total: 1_320 };
    const reset = { input: 300, output: 50, cacheRead: 0, cacheWrite: 0, total: 350 };
    expect(hasCounterDecrease(prev, reset)).toBe(true);
    const delta = interactiveUsageDelta(prev, reset);
    expect(delta.input).toBe(-700);
    expect(delta.total).toBe(-970);
  });

  it('does not flag a strictly growing sample', () => {
    expect(
      hasCounterDecrease(
        { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, total: 110 },
        { input: 300, output: 40, cacheRead: 50, cacheWrite: 5, total: 395 },
      ),
    ).toBe(false);
  });
});

describe('normalizeInteractiveUsage', () => {
  it('accepts a well-formed wire payload with snake_case counts', () => {
    expect(
      normalizeInteractiveUsage({
        event_id: 'evt-1',
        input: 1_450,
        output: 320,
        cache_read: 180,
        cache_write: 40,
        total: 1_990,
      }),
    ).toEqual({
      eventId: 'evt-1',
      input: 1_450,
      output: 320,
      cacheRead: 180,
      cacheWrite: 40,
      total: 1_990,
    });
  });

  it('accepts a reasoning count when the provider reports one', () => {
    expect(
      normalizeInteractiveUsage({ event_id: 'evt-3', input: 10, output: 2, reasoning: 40_485 }),
    ).toEqual({ eventId: 'evt-3', input: 10, output: 2, reasoning: 40_485 });
  });

  it('rejects a present-but-invalid reasoning count', () => {
    expect(
      normalizeInteractiveUsage({ event_id: 'evt-4', input: 10, output: 2, reasoning: -1 }),
    ).toBeNull();
  });

  it('accepts partial counts — cache and total are optional', () => {
    expect(
      normalizeInteractiveUsage({ event_id: 'evt-2', input: 10, output: 2 }),
    ).toEqual({ eventId: 'evt-2', input: 10, output: 2 });
  });

  it.each([
    ['missing event id', { input: 10, output: 2 }],
    ['non-string event id', { event_id: 7, input: 10, output: 2 }],
    ['empty event id', { event_id: '', input: 10, output: 2 }],
    ['non-numeric input', { event_id: 'e', input: '10', output: 2 }],
    ['non-numeric output', { event_id: 'e', input: 10, output: {} }],
    ['negative input', { event_id: 'e', input: -1, output: 2 }],
    ['NaN total', { event_id: 'e', input: 10, output: 2, total: NaN }],
    ['infinite cache read', { event_id: 'e', input: 10, output: 2, cache_read: Infinity }],
    ['no counters at all', { event_id: 'e' }],
  ])('rejects %s — a non-count is not a count', (_label, raw) => {
    expect(normalizeInteractiveUsage(raw)).toBeNull();
  });

  it('rejects a non-object payload', () => {
    expect(normalizeInteractiveUsage(null)).toBeNull();
    expect(normalizeInteractiveUsage(7)).toBeNull();
    expect(normalizeInteractiveUsage('usage')).toBeNull();
    expect(normalizeInteractiveUsage([1, 2])).toBeNull();
  });
});
