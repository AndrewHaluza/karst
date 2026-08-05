import { describe, it, expect } from 'vitest';
import {
  DEFAULT_USAGE_LIMIT,
  MAX_USAGE_LIMIT,
  parseUsageQuery,
  resolveUsageRange,
  USAGE_RANGES,
  USAGE_SORTS,
} from './tokenUsageQuery.js';

function ok(raw: unknown) {
  const parsed = parseUsageQuery(raw);
  if (!parsed.ok) throw new Error(`expected ok, got: ${parsed.error}`);
  return parsed.query;
}

function err(raw: unknown): string {
  const parsed = parseUsageQuery(raw);
  if (parsed.ok) throw new Error('expected a validation error');
  return parsed.error;
}

describe('parseUsageQuery', () => {
  it('defaults everything when given nothing', () => {
    expect(ok(undefined)).toEqual({
      projectId: null,
      ticketId: null,
      from: null,
      to: null,
      limit: DEFAULT_USAGE_LIMIT,
      offset: 0,
      // Effective, not raw: an unsorted view must not rank by how many cached
      // turns a call took (see `tokenWeights.ts`).
      sort: 'effective',
    });
  });

  it('offers effective tokens as a sort key', () => {
    expect(USAGE_SORTS).toContain('effective');
    expect(ok({ sort: 'effective' }).sort).toBe('effective');
  });

  it('accepts a well-formed query', () => {
    expect(
      ok({
        projectId: 3,
        ticketId: 12,
        from: '2026-07-01T00:00:00.000Z',
        to: '2026-08-01T00:00:00.000Z',
        limit: 10,
        offset: 20,
        sort: 'output',
      }),
    ).toEqual({
      projectId: 3,
      ticketId: 12,
      from: '2026-07-01T00:00:00.000Z',
      to: '2026-08-01T00:00:00.000Z',
      limit: 10,
      offset: 20,
      sort: 'output',
    });
  });

  it('normalizes a loose but valid timestamp to ISO-8601', () => {
    expect(ok({ from: '2026-07-01' }).from).toBe('2026-07-01T00:00:00.000Z');
  });

  it('rejects an unparseable time range with a clear error', () => {
    expect(err({ from: 'last tuesday' })).toMatch(/from/i);
    expect(err({ to: '' })).toMatch(/to/i);
    expect(err({ from: 42 })).toMatch(/from/i);
  });

  it('rejects an inverted range rather than silently returning nothing', () => {
    expect(err({ from: '2026-08-01T00:00:00Z', to: '2026-07-01T00:00:00Z' })).toMatch(
      /before|after|range/i,
    );
  });

  it('rejects a non-positive-integer id', () => {
    expect(err({ ticketId: 0 })).toMatch(/ticketId/);
    expect(err({ ticketId: -1 })).toMatch(/ticketId/);
    expect(err({ ticketId: 1.5 })).toMatch(/ticketId/);
    expect(err({ projectId: 'all' })).toMatch(/projectId/);
  });

  it('caps pagination instead of trusting it', () => {
    expect(err({ limit: MAX_USAGE_LIMIT + 1 })).toMatch(/limit/);
    expect(err({ limit: 0 })).toMatch(/limit/);
    expect(err({ offset: -1 })).toMatch(/offset/);
    expect(ok({ limit: MAX_USAGE_LIMIT }).limit).toBe(MAX_USAGE_LIMIT);
  });

  it('rejects a sort key that is not in the closed set', () => {
    for (const sort of USAGE_SORTS) expect(ok({ sort }).sort).toBe(sort);
    expect(err({ sort: 'total_tokens; DROP TABLE token_usage' })).toMatch(/sort/);
  });

  it('rejects a non-object query', () => {
    expect(err('total')).toMatch(/query/i);
    expect(err([])).toMatch(/query/i);
  });

  it('treats explicit nulls as "unset", not as invalid', () => {
    expect(ok({ from: null, to: null, ticketId: null }).from).toBeNull();
  });
});

describe('resolveUsageRange', () => {
  const now = new Date('2026-08-01T12:00:00.000Z');

  it('offers an all-time range that filters nothing', () => {
    expect(resolveUsageRange('all', now)).toEqual({ from: null, to: null });
  });

  it('cuts a rolling window back from now', () => {
    expect(resolveUsageRange('24h', now)).toEqual({
      from: '2026-07-31T12:00:00.000Z',
      to: null,
    });
    expect(resolveUsageRange('7d', now).from).toBe('2026-07-25T12:00:00.000Z');
    expect(resolveUsageRange('30d', now).from).toBe('2026-07-02T12:00:00.000Z');
  });

  it('falls back to all-time for an unknown range id', () => {
    expect(resolveUsageRange('forever', now)).toEqual({ from: null, to: null });
  });

  it('publishes every offered range with a label', () => {
    expect(USAGE_RANGES.map((r) => r.id)).toEqual(['24h', '7d', '30d', 'all']);
    for (const range of USAGE_RANGES) expect(range.label).not.toBe('');
  });
});
