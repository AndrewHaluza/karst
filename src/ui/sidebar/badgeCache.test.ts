import { describe, it, expect } from 'vitest';
import { BadgeCache, type BadgeTarget, type BadgeValue } from './badgeCache.js';

function fakeTarget(): BadgeTarget & { applied: Array<BadgeValue | undefined> } {
  const t = {
    applied: [] as Array<BadgeValue | undefined>,
    setBadge: (badge: BadgeValue | undefined) => {
      t.applied.push(badge);
    },
  };
  return t;
}

describe('BadgeCache', () => {
  it('replays the last value onto a target that attaches later', () => {
    const cache = new BadgeCache();
    cache.set(2, 'two');
    const target = fakeTarget();
    cache.attach(target);
    expect(target.applied).toEqual([{ value: 2, tooltip: 'two' }]);
  });

  it('applies straight through once attached', () => {
    const cache = new BadgeCache();
    const target = fakeTarget();
    cache.attach(target);
    cache.set(3, 'three');
    expect(target.applied).toEqual([undefined, { value: 3, tooltip: 'three' }]);
  });

  it('clears rather than rendering a zero bubble', () => {
    const cache = new BadgeCache();
    const target = fakeTarget();
    cache.attach(target);
    cache.set(0, 'none');
    expect(target.applied).toEqual([undefined, undefined]);
  });

  it('replays a clear, not a stale count, on re-resolve', () => {
    const cache = new BadgeCache();
    cache.set(2, 'two');
    cache.clear();
    const target = fakeTarget();
    cache.attach(target);
    expect(target.applied).toEqual([undefined]);
  });

  it('survives set and clear with no target attached', () => {
    const cache = new BadgeCache();
    expect(() => {
      cache.set(1, 'one');
      cache.clear();
    }).not.toThrow();
  });

  it('does not touch the old target after detach', () => {
    const cache = new BadgeCache();
    const target = fakeTarget();
    cache.attach(target);
    cache.detach();
    cache.set(5, 'five');
    cache.clear();
    expect(target.applied).toEqual([undefined]);
  });

  it('replays the current value onto a new target after detach then re-attach', () => {
    const cache = new BadgeCache();
    const oldTarget = fakeTarget();
    cache.attach(oldTarget);
    cache.set(4, 'four');
    cache.detach();
    const newTarget = fakeTarget();
    cache.attach(newTarget);
    expect(newTarget.applied).toEqual([{ value: 4, tooltip: 'four' }]);
  });
});
