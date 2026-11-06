import { describe, expect, it, vi } from 'vitest';
import { openStore } from '../../store/db.js';
import { createTicket } from '../../store/tickets.js';
import { guardHookNotify, isForeignProjectTicket, refuseForeignProjectTicket } from './foreignProject.js';

function seed() {
  const store = openStore(':memory:');
  const mine = createTicket(store, { key: 'A', title: 'a', projectId: 1 });
  const other = createTicket(store, { key: 'B', title: 'b', projectId: 2 });
  const legacy = createTicket(store, { key: 'C', title: 'c' });
  return { store, mine: mine.id, other: other.id, legacy: legacy.id };
}

describe('isForeignProjectTicket', () => {
  it('refuses only a ticket of another project', () => {
    const { store, mine, other } = seed();
    expect(isForeignProjectTicket(store, other, 1)).toBe(true);
    expect(isForeignProjectTicket(store, mine, 1)).toBe(false);
  });
  it('does not refuse when the window has no project', () => {
    const { store, other } = seed();
    expect(isForeignProjectTicket(store, other, undefined)).toBe(false);
    expect(isForeignProjectTicket(store, other, null)).toBe(false);
  });
  it('does not refuse a legacy ticket with a null project id', () => {
    const { store, legacy } = seed();
    expect(isForeignProjectTicket(store, legacy, 1)).toBe(false);
  });
  it('does not refuse an unknown ticket', () => {
    const { store } = seed();
    expect(isForeignProjectTicket(store, 9999, 1)).toBe(false);
  });
});

describe('refuseForeignProjectTicket', () => {
  it('logs each refusal and returns true', () => {
    const { store, other } = seed();
    const log = vi.fn();
    expect(refuseForeignProjectTicket(store, other, 1, 'hook', log)).toBe(true);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toContain('hook');
  });
  it('stays silent for an own ticket', () => {
    const { store, mine } = seed();
    const log = vi.fn();
    expect(refuseForeignProjectTicket(store, mine, 1, 'hook', log)).toBe(false);
    expect(log).not.toHaveBeenCalled();
  });
});

describe('guardHookNotify', () => {
  it('runs no side effect for a ticket of another project', () => {
    const { store, other, mine } = seed();
    const inner = vi.fn();
    const log = vi.fn();
    const notify = guardHookNotify(store, () => 1, log, inner);
    notify(other, {});
    expect(inner).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
    notify(mine, {});
    expect(inner).toHaveBeenCalledTimes(1);
  });
  it('reads the current project at call time', () => {
    const { store, other } = seed();
    const inner = vi.fn();
    let pid: number | undefined;
    const notify = guardHookNotify(store, () => pid, vi.fn(), inner);
    notify(other, {});
    expect(inner).toHaveBeenCalledTimes(1);
    pid = 1;
    notify(other, {});
    expect(inner).toHaveBeenCalledTimes(1);
  });
});
