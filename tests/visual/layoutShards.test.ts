import { describe, expect, it } from 'vitest';
import { isMergeRun, mergeGap } from './layoutShards.js';

describe('isMergeRun', () => {
  it('is true only for KARST_LAYOUT_MERGE=1', () => {
    expect(isMergeRun({ KARST_LAYOUT_MERGE: '1' })).toBe(true);
    for (const value of [undefined, '', '0', 'true']) {
      expect(isMergeRun({ KARST_LAYOUT_MERGE: value }), String(value)).toBe(false);
    }
  });
});

describe('mergeGap', () => {
  const expected = ['a@1', 'a@2', 'b@1'];

  it('is empty when the shard files hold every expected run', () => {
    expect(mergeGap(new Set(expected), expected)).toBe('');
    expect(mergeGap(new Set([...expected, 'extra@1']), expected)).toBe('');
  });

  it('names the count and the runs that no shard file holds', () => {
    const gap = mergeGap(new Set(['a@1']), expected);
    expect(gap).toMatch(/^2 layout run\(s\) have no shard file/);
    expect(gap).toContain('a@2');
    expect(gap).toContain('b@1');
  });

  it('fails closed on an empty download', () => {
    expect(mergeGap(new Set(), expected)).toMatch(/^3 layout run\(s\)/);
  });

  it('shows at most 20 missing runs', () => {
    const many = Array.from({ length: 30 }, (_, i) => `r${i}@1`);
    const gap = mergeGap(new Set(), many);
    expect(gap).toMatch(/^30 layout run\(s\)/);
    expect(gap).toContain('r19@1');
    expect(gap).not.toContain('r20@1');
  });
});
