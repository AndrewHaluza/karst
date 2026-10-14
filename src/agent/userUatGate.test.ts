import { describe, expect, it } from 'vitest';
import { createUserUatGate } from './userUatGate.js';

describe('createUserUatGate', () => {
  it('withholds per ticket until released', () => {
    const g = createUserUatGate();
    expect(g.isWithheld(7)).toBe(false);
    g.withhold(7);
    expect(g.isWithheld(7)).toBe(true);
    expect(g.isWithheld(8)).toBe(false);
    g.release(7);
    expect(g.isWithheld(7)).toBe(false);
  });
});
