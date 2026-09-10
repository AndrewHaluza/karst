import { describe, it, expect } from 'vitest';
import { SEVERITY_RANK, sortBySeverityDesc } from './severityOrder.js';

describe('SEVERITY_RANK', () => {
  it('ranks critical (0) through info (4)', () => {
    expect(SEVERITY_RANK).toEqual({
      critical: 0,
      high: 1,
      medium: 2,
      low: 3,
      info: 4,
    });
  });
});

describe('sortBySeverityDesc', () => {
  it('orders worst-first', () => {
    const input = [
      { severity: 'low' },
      { severity: 'critical' },
      { severity: 'info' },
      { severity: 'high' },
      { severity: 'medium' },
    ];
    const result = sortBySeverityDesc(input);
    expect(result).toEqual([
      { severity: 'critical' },
      { severity: 'high' },
      { severity: 'medium' },
      { severity: 'low' },
      { severity: 'info' },
    ]);
  });

  it('is stable within a rank', () => {
    const input = [
      { severity: 'high', title: 'first' },
      { severity: 'high', title: 'second' },
      { severity: 'critical', title: 'third' },
    ];
    const result = sortBySeverityDesc(input);
    expect(result).toEqual([
      { severity: 'critical', title: 'third' },
      { severity: 'high', title: 'first' },
      { severity: 'high', title: 'second' },
    ]);
  });

  it('sorts an unknown severity after info', () => {
    const input = [
      { severity: 'unknown' },
      { severity: 'info' },
      { severity: 'critical' },
    ];
    const result = sortBySeverityDesc(input);
    expect(result).toEqual([
      { severity: 'critical' },
      { severity: 'info' },
      { severity: 'unknown' },
    ]);
  });

  it('does not mutate the input array', () => {
    const input = [{ severity: 'low' }, { severity: 'high' }];
    sortBySeverityDesc(input);
    expect(input.map((r) => r.severity)).toEqual(['low', 'high']);
  });

  it('returns an empty array for an empty input', () => {
    expect(sortBySeverityDesc([])).toEqual([]);
  });
});
