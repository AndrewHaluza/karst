import { describe, expect, it } from 'vitest';
import { baselineCollisions, type BaselineShot } from './baselineDistinct.js';

const shot = (theme: string, baseline: string, hash: string): BaselineShot => ({ theme, baseline, hash });

describe('baselineCollisions', () => {
  it('reports two baselines in one theme with the same hash', () => {
    const r = baselineCollisions([shot('dark', 'b', 'h1'), shot('dark', 'a', 'h1'), shot('dark', 'c', 'h2')], []);
    expect(r.unexpected).toEqual(['dark: a = b']);
    expect(r.stale).toEqual([]);
  });

  it('ignores the same hash in two themes', () => {
    expect(baselineCollisions([shot('dark', 'a', 'h1'), shot('light', 'b', 'h1')], []).unexpected).toEqual([]);
  });

  it('ignores one baseline listed twice in one theme', () => {
    expect(baselineCollisions([shot('dark', 'a', 'h1'), shot('dark', 'a', 'h1')], []).unexpected).toEqual([]);
  });

  it('accepts a collision that one allow-list entry covers, in every theme', () => {
    const shots = [shot('dark', 'a', 'h1'), shot('dark', 'b', 'h1'), shot('light', 'a', 'h3'), shot('light', 'b', 'h3')];
    const r = baselineCollisions(shots, [{ baselines: ['b', 'a'], reason: 'r' }]);
    expect(r).toEqual({ unexpected: [], stale: [] });
  });

  it('needs every member of a three-way group in one entry', () => {
    const shots = [shot('dark', 'a', 'h'), shot('dark', 'b', 'h'), shot('dark', 'c', 'h')];
    expect(baselineCollisions(shots, [{ baselines: ['a', 'b'], reason: 'r' }]).unexpected).toEqual(['dark: a = b = c']);
    expect(baselineCollisions(shots, [{ baselines: ['a', 'b', 'c'], reason: 'r' }]).unexpected).toEqual([]);
  });

  it('sorts the unexpected groups', () => {
    const shots = [shot('light', 'x', 'h'), shot('light', 'y', 'h'), shot('dark', 'p', 'g'), shot('dark', 'q', 'g')];
    expect(baselineCollisions(shots, []).unexpected).toEqual(['dark: p = q', 'light: x = y']);
  });

  it('reports an allow-list entry that no longer collides as stale', () => {
    const r = baselineCollisions([shot('dark', 'b', 'h1'), shot('dark', 'a', 'h2')], [{ baselines: ['b', 'a'], reason: 'r' }]);
    expect(r.stale).toEqual(['a = b']);
  });

  it('reports an entry as stale when only part of it still collides', () => {
    const shots = [shot('dark', 'a', 'h'), shot('dark', 'b', 'h'), shot('dark', 'c', 'x')];
    expect(baselineCollisions(shots, [{ baselines: ['a', 'b', 'c'], reason: 'r' }]).stale).toEqual(['a = b = c']);
  });
});
