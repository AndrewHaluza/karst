import { describe, it, expect } from 'vitest';
import { dependentsAbove, isHigherLevel, type DependentNode } from './queueDependents.js';

const n = (id: string, ownPriority: DependentNode['ownPriority'], ...waitsOn: string[]): DependentNode => ({ id, ownPriority, waitsOn });

describe('isHigherLevel', () => {
  it('ranks urgent > high > normal > low and reads null as normal', () => {
    expect(isHigherLevel('urgent', 'high')).toBe(true);
    expect(isHigherLevel('high', 'high')).toBe(false);
    expect(isHigherLevel('low', 'normal')).toBe(false);
    expect(isHigherLevel(null, 'low')).toBe(true);
    expect(isHigherLevel(null, 'normal')).toBe(false);
  });
});

describe('dependentsAbove', () => {
  it('walks a chain transitively', () => {
    const items = [n('D1', 'low'), n('D2', 'high', 'D1'), n('D3', 'high', 'D2')];
    expect(dependentsAbove(items, 'D1', 'low')).toEqual(['D2', 'D3']);
  });

  it('reaches a diamond dependent once', () => {
    const items = [n('D1', 'low'), n('D2', 'high', 'D1'), n('D3', 'high', 'D1'), n('D4', 'urgent', 'D2', 'D3')];
    expect(dependentsAbove(items, 'D1', 'low')).toEqual(['D2', 'D3', 'D4']);
  });

  it('terminates on a cycle and leaves the root out', () => {
    const items = [n('D1', 'low', 'D2'), n('D2', 'high', 'D1')];
    expect(dependentsAbove(items, 'D1', 'low')).toEqual(['D2']);
  });

  it('follows cross-session drafts and ticket edges alike', () => {
    const items = [n('T1', 'low'), n('D7', 'high', 'T1'), n('T2', 'urgent', 'D7')];
    expect(dependentsAbove(items, 'T1', 'low')).toEqual(['D7', 'T2']);
  });

  it('skips a dependent whose own level is equal or lower, but walks through it', () => {
    const items = [n('D1', 'low'), n('D2', 'low', 'D1'), n('D3', 'high', 'D2'), n('D4', 'normal', 'D1')];
    expect(dependentsAbove(items, 'D1', 'normal')).toEqual(['D3']);
    expect(dependentsAbove(items, 'D1', 'low')).toEqual(['D3', 'D4']);
  });

  it('reads a null own level as normal and ignores an id outside the set', () => {
    const items = [n('D1', 'low'), n('D2', null, 'D1', 'T99')];
    expect(dependentsAbove(items, 'D1', 'low')).toEqual(['D2']);
    expect(dependentsAbove(items, 'D1', 'normal')).toEqual([]);
  });

  it('ignores items that do not wait on the root', () => {
    expect(dependentsAbove([n('D1', 'low'), n('D2', 'high')], 'D1', 'low')).toEqual([]);
  });
});
