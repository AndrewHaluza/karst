import { describe, it, expect } from 'vitest';
import { formatExactDuration } from './types.js';

describe('formatExactDuration', () => {
  it('returns empty for a missing start or end', () => {
    expect(formatExactDuration(null, '2026-08-09T12:00:00.000Z')).toBe('');
    expect(formatExactDuration('2026-08-09T12:00:00.000Z', null)).toBe('');
    expect(formatExactDuration(undefined, undefined)).toBe('');
  });

  it('returns empty for an unparseable stamp', () => {
    expect(formatExactDuration('not-a-date', '2026-08-09T12:00:00.000Z')).toBe('');
    expect(formatExactDuration('2026-08-09T12:00:00.000Z', 'also-not')).toBe('');
  });

  it('returns empty for a negative span', () => {
    expect(formatExactDuration('2026-08-09T12:01:00.000Z', '2026-08-09T12:00:00.000Z')).toBe('');
  });

  it('states a zero-length span as a recorded instant, not an absence', () => {
    expect(formatExactDuration('2026-08-09T12:00:00.000Z', '2026-08-09T12:00:00.000Z')).toBe('0.000s');
  });

  it('states the span exactly, to the millisecond', () => {
    expect(
      formatExactDuration('2026-08-09T12:00:00.000Z', '2026-08-09T12:04:34.281Z'),
    ).toBe('274.281s');
  });
});
