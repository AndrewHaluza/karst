import { describe, it, expect } from 'vitest';
import { formatTokens, formatExactTokens, formatShare, shareOfTotal } from './tokenFormat.js';

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
    expect(formatExactTokens(1_234_567, 'en-US')).toBe('1,234,567');
    expect(formatExactTokens(0, 'en-US')).toBe('0');
  });

  it('uses the viewer locale by default (US-17)', () => {
    expect(formatExactTokens(1_234_567)).toBe((1_234_567).toLocaleString());
  });

  it('renders a nonsensical count as unknown', () => {
    expect(formatExactTokens(-1)).toBe('—');
    expect(formatExactTokens(Number.NaN)).toBe('—');
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

describe('formatShare (US-18)', () => {
  it('words an ordinary share', () => {
    expect(formatShare(25, 100)).toBe('25%');
    expect(formatShare(1, 3)).toBe('33.3%');
  });

  it('is 0% for no spend and for an empty total', () => {
    expect(formatShare(0, 0)).toBe('0%');
    expect(formatShare(0, 100)).toBe('0%');
  });

  it('never rounds a real but tiny share down to 0%', () => {
    expect(formatShare(1, 100_000)).toBe('<0.1%');
  });
});
