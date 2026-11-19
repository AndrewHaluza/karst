import { describe, expect, it } from 'vitest';
import { diffPaths, formatChange, formatValue, topKey } from './pathDiff.js';

describe('diffPaths', () => {
  it('names the path of a changed leaf with the old and the new value', () => {
    const before = { repositories: { web: { service: { healthTimeoutSeconds: 30 } } } };
    const after = { repositories: { web: { service: { healthTimeoutSeconds: 60 } } } };
    expect(diffPaths(before, after)).toEqual([
      { path: 'repositories.web.service.healthTimeoutSeconds', before: 30, after: 60 },
    ]);
  });

  it('treats an array as one leaf', () => {
    expect(diffPaths({ a: { l: [1] } }, { a: { l: [1, 2] } })).toEqual([{ path: 'a.l', before: [1], after: [1, 2] }]);
  });

  it('lists every leaf of an added or removed mapping', () => {
    expect(diffPaths({}, { r: { x: 1, y: { z: 2 } } })).toEqual([
      { path: 'r.x', before: undefined, after: 1 },
      { path: 'r.y.z', before: undefined, after: 2 },
    ]);
    expect(diffPaths({ r: { x: 1 } }, {})).toEqual([{ path: 'r.x', before: 1, after: undefined }]);
  });

  it('keeps an empty mapping as one leaf', () => {
    expect(diffPaths({}, { r: {} })).toEqual([{ path: 'r', before: undefined, after: {} }]);
    expect(diffPaths({ r: {} }, {})).toEqual([{ path: 'r', before: {}, after: undefined }]);
  });

  it('equals an undefined key to an absent key and finds no change in equal trees', () => {
    expect(diffPaths({ a: undefined, b: 1 }, { b: 1 })).toEqual([]);
    expect(diffPaths(undefined, undefined)).toEqual([]);
  });

  it('sorts the keys and diffs an undefined tree against a full one', () => {
    expect(diffPaths(undefined, { b: 1, a: 2 }).map((c) => c.path)).toEqual(['a', 'b']);
  });

  it('formats a change, a missing value and the top key', () => {
    expect(formatChange({ path: 'a.b', before: undefined, after: 'x' })).toBe('a.b: (absent) -> "x"');
    expect(formatValue(3)).toBe('3');
    expect(topKey('uat.gates')).toBe('uat');
    expect(topKey('debug')).toBe('debug');
  });
});
