import { describe, expect, it } from 'vitest';
import { MAX_VIEW_COLUMN, diffViewColumn } from './diffColumn.js';

describe('diffViewColumn', () => {
  it('anchors the diff one column right of the panel that asked for it', () => {
    expect(diffViewColumn(1)).toBe(2);
    expect(diffViewColumn(2)).toBe(3);
  });

  it('is stable across repeated clicks from the same panel', () => {
    const columns = [1, 1, 1].map(diffViewColumn);
    expect(new Set(columns).size).toBe(1);
  });

  it('falls back to the host default when the panel has no column', () => {
    expect(diffViewColumn(undefined)).toBeUndefined();
  });

  it('rejects a column that is not a usable editor group', () => {
    expect(diffViewColumn(0)).toBeUndefined();
    expect(diffViewColumn(-1)).toBeUndefined();
    expect(diffViewColumn(Number.NaN)).toBeUndefined();
    expect(diffViewColumn(1.5)).toBe(2);
  });

  it('clamps at the last editor group instead of naming one that cannot exist', () => {
    expect(diffViewColumn(MAX_VIEW_COLUMN)).toBe(MAX_VIEW_COLUMN);
    expect(diffViewColumn(MAX_VIEW_COLUMN - 1)).toBe(MAX_VIEW_COLUMN);
  });
});
