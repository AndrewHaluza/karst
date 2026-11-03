import { describe, it, expect, vi } from 'vitest';
import { guardedHandOff } from './guardedHandOff.js';

const make = (over: { paused?: boolean; sessions?: boolean } = {}) => {
  const handOff = vi.fn();
  const fn = guardedHandOff({ paused: () => over.paused ?? false, sessionsAvailable: () => over.sessions ?? true, handOff });
  return { fn, handOff };
};

describe('guardedHandOff', () => {
  it('delivers and returns null', () => {
    const { fn, handOff } = make();
    expect(fn('go')).toBeNull();
    expect(handOff).toHaveBeenCalledWith('go', '');
  });
  it('refuses a paused ticket without delivering', () => {
    const { fn, handOff } = make({ paused: true });
    expect(fn('go')).toMatch(/paused/);
    expect(handOff).not.toHaveBeenCalled();
  });
  it('refuses when sessions are unavailable', () => {
    const { fn, handOff } = make({ sessions: false });
    expect(fn('go')).toMatch(/sessions/);
    expect(handOff).not.toHaveBeenCalled();
  });
});
