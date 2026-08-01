import { describe, it, expect } from 'vitest';
import { formatTokens, formatExactTokens, shareOfTotal } from './tokenFormat.js';

describe('formatTokens', () => {
  it('prints small counts exactly', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(1)).toBe('1');
    expect(formatTokens(999)).toBe('999');
  });

  it('abbreviates thousands and millions', () => {
    expect(formatTokens(1_000)).toBe('1k');
    expect(formatTokens(1_234)).toBe('1.2k');
    expect(formatTokens(999_999)).toBe('1000k');
    expect(formatTokens(1_000_000)).toBe('1M');
    expect(formatTokens(1_240_000)).toBe('1.2M');
  });

  it('never prints a trailing .0 — false precision reads as a measurement', () => {
    expect(formatTokens(2_000)).toBe('2k');
    expect(formatTokens(3_000_000)).toBe('3M');
  });

  it('renders a nonsensical count as unknown rather than as zero spend', () => {
    expect(formatTokens(-1)).toBe('—');
    expect(formatTokens(Number.NaN)).toBe('—');
  });
});

describe('formatExactTokens', () => {
  it('groups the exact value for the tooltip', () => {
    expect(formatExactTokens(1_234_567)).toBe('1,234,567');
    expect(formatExactTokens(0)).toBe('0');
  });
});

describe('shareOfTotal', () => {
  it('reports a percentage to one decimal', () => {
    expect(shareOfTotal(25, 100)).toBe(25);
    expect(shareOfTotal(1, 3)).toBe(33.3);
  });

  it('is 0 for an empty total rather than NaN', () => {
    expect(shareOfTotal(0, 0)).toBe(0);
    expect(shareOfTotal(5, 0)).toBe(0);
  });
});
