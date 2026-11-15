import { describe, it, expect } from 'vitest';
import { createDrain } from './drain.js';

describe('createDrain', () => {
  it('starts clear, drains on begin, clears on cancel', () => {
    const d = createDrain();
    expect(d.isDraining()).toBe(false);
    d.begin();
    expect(d.isDraining()).toBe(true);
    d.cancel();
    expect(d.isDraining()).toBe(false);
  });
});
