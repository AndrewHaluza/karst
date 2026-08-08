import { describe, it, expect } from 'vitest';
import { bounded } from './bounds.js';

describe('bounded', () => {
  it('shows everything when the list fits the limit, with nothing remaining', () => {
    expect(bounded([1, 2, 3], 5)).toEqual({ shown: [1, 2, 3], remaining: 0 });
  });

  it('shows the first `limit` items and reports the exact remainder', () => {
    expect(bounded(['a', 'b', 'c', 'd', 'e'], 3)).toEqual({
      shown: ['a', 'b', 'c'],
      remaining: 2,
    });
  });

  it('slices at the limit — total minus shown is the remainder', () => {
    const items = [1, 2, 3, 4];
    const { shown, remaining } = bounded(items, 2);
    expect(shown).toEqual([1, 2]);
    expect(shown.length + remaining).toBe(items.length);
  });

  it('returns an empty shown list at a limit of zero, keeping every item in the remainder', () => {
    expect(bounded([1, 2, 3], 0)).toEqual({ shown: [], remaining: 3 });
  });

  it('never reports a negative remainder when the limit exceeds the list', () => {
    expect(bounded([1], 10).remaining).toBe(0);
  });

  it('is a no-op on an empty list', () => {
    expect(bounded([], 4)).toEqual({ shown: [], remaining: 0 });
  });
});
