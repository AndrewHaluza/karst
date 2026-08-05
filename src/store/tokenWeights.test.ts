import { describe, expect, it } from 'vitest';
import {
  TOKEN_WEIGHTS,
  effectiveTokens,
  effectiveTokensSql,
} from './tokenWeights.js';

describe('effectiveTokens', () => {
  it('prices a cache read at a tenth of a fresh input token', () => {
    expect(effectiveTokens({ input: 0, output: 0, cacheRead: 1000, cacheWrite: 0 })).toBe(100);
  });

  it('prices a cache write above a fresh input token', () => {
    expect(effectiveTokens({ input: 0, output: 0, cacheRead: 0, cacheWrite: 1000 })).toBe(1250);
  });

  it('prices an output token above every input-side token', () => {
    const { output, input, cacheWrite, cacheRead } = TOKEN_WEIGHTS;
    expect(output).toBeGreaterThan(input);
    expect(input).toBeGreaterThan(cacheRead);
    expect(cacheWrite).toBeGreaterThan(input);
    expect(effectiveTokens({ input: 0, output: 1000, cacheRead: 0, cacheWrite: 0 })).toBe(5000);
  });

  it('sums the four weighted components into one integer', () => {
    expect(effectiveTokens({ input: 234, output: 51_951, cacheRead: 7_216_861, cacheWrite: 1_050_479 })).toBe(
      Math.round(234 + 51_951 * 5 + 7_216_861 * 0.1 + 1_050_479 * 1.25),
    );
  });

  it('never returns a fraction — the view renders whole tokens', () => {
    expect(Number.isInteger(effectiveTokens({ input: 1, output: 1, cacheRead: 7, cacheWrite: 3 }))).toBe(
      true,
    );
  });

  it('reorders a raw-total ranking when one group is mostly cache reads', () => {
    // The real registry shape that made this ticket: review-findings outranks
    // ticket-analysis on raw tokens purely because it re-read a big cache.
    const reviewRaw = 37 + 9018 + 1_461_747 + 86_100;
    const analysisRaw = 30 + 11_549 + 262_394 + 408_878;
    expect(reviewRaw).toBeGreaterThan(analysisRaw);

    const review = effectiveTokens({
      input: 37,
      output: 9018,
      cacheRead: 1_461_747,
      cacheWrite: 86_100,
    });
    const analysis = effectiveTokens({
      input: 30,
      output: 11_549,
      cacheRead: 262_394,
      cacheWrite: 408_878,
    });
    expect(review).toBeLessThan(analysis);
  });
});

describe('effectiveTokensSql', () => {
  it('names every weight from the same constants the JS reader uses', () => {
    const sql = effectiveTokensSql();
    for (const weight of Object.values(TOKEN_WEIGHTS)) {
      expect(sql).toContain(String(weight));
    }
  });

  it('qualifies every column with the given table alias', () => {
    const sql = effectiveTokensSql('u.');
    expect(sql).toContain('u.input_tokens');
    expect(sql).toContain('u.output_tokens');
    expect(sql).toContain('u.cache_read_tokens');
    expect(sql).toContain('u.cache_write_tokens');
    expect(sql).not.toMatch(/[^.]\binput_tokens/);
  });
});
