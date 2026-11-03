import { describe, it, expect, vi } from 'vitest';
import { guardedHandOff, ticketHandOff } from './guardedHandOff.js';

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

describe('ticketHandOff', () => {
  it('nudges a live terminal and focuses it, without opening', () => {
    const open = vi.fn(); const focus = vi.fn();
    const fn = ticketHandOff({ paused: () => false, sessionsAvailable: () => true, isGraphTicket: () => false, nudge: () => true, focus, open });
    expect(fn('go')).toBeNull();
    expect(focus).toHaveBeenCalledOnce();
    expect(open).not.toHaveBeenCalled();
  });
  it('opens a seeded session when no terminal is live', () => {
    const open = vi.fn();
    const fn = ticketHandOff({ paused: () => false, sessionsAvailable: () => true, isGraphTicket: () => false, nudge: () => false, focus: vi.fn(), open });
    expect(fn('go')).toBeNull();
    expect(open).toHaveBeenCalledWith('go', '');
  });
});
