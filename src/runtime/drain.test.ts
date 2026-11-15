import { describe, it, expect } from 'vitest';
import { createDrain } from './drain.js';

describe('createDrain', () => {
  it('starts clear, drains on begin, clears on cancel', () => {
    const d = createDrain();
    expect(d.isDraining()).toBe(false);
    d.begin();
    expect(d.isDraining()).toBe(true);
    expect(d.cancel()).toEqual([]);
    expect(d.isDraining()).toBe(false);
  });

  it('returns each held ticket once on cancel, then forgets them', () => {
    const d = createDrain();
    d.begin();
    d.hold(4);
    d.hold(4);
    d.hold(9);
    expect(d.cancel()).toEqual([4, 9]);
    expect(d.cancel()).toEqual([]);
  });

  it('counts a tracked run until it settles, also when it throws', async () => {
    const d = createDrain();
    let release!: () => void;
    const p = d.track(() => new Promise<void>((r) => { release = r; }));
    expect(d.inFlight()).toBe(1);
    release();
    await p;
    expect(d.inFlight()).toBe(0);
    await expect(d.track(async () => { throw new Error('x'); })).rejects.toThrow('x');
    expect(d.inFlight()).toBe(0);
  });
});
