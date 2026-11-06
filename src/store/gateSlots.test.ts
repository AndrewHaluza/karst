import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStore, type Store } from './db.js';
import { acquireGateSlot, countGateSlots, reapStaleGateSlots, releaseGateSlot, touchGateSlot } from './gateSlots.js';

let store: Store;
beforeEach(() => { store = openStore(':memory:'); });
afterEach(() => store.close());

const take = (ticketId: number, limit = 2, projectId: number | null = 1): number | null => acquireGateSlot(store, { ticketId, projectId, owner: 'w1', limit });
const age = (id: number, seconds: number): void =>
  void store.db.prepare("UPDATE gate_slots SET touched_at = strftime('%Y-%m-%d %H:%M:%f', 'now', ?) WHERE id = ?").run(`-${seconds} seconds`, id);

describe('gate slots', () => {
  it('grants at most `limit` slots per project, atomically', () => {
    expect(take(1)).not.toBeNull();
    expect(take(2)).not.toBeNull();
    expect(take(3)).toBeNull();
    expect(countGateSlots(store, 1)).toBe(2);
  });

  it('counts projects separately', () => {
    take(1, 1, 1);
    expect(take(2, 1, 2)).not.toBeNull();
    expect(take(3, 1, 1)).toBeNull();
  });

  it('release frees the slot for a waiter, and is idempotent', () => {
    const a = take(1, 1)!;
    expect(take(2, 1)).toBeNull();
    releaseGateSlot(store, a);
    releaseGateSlot(store, a);
    expect(take(2, 1)).not.toBeNull();
  });

  it('0 is unlimited and takes no row', () => {
    for (let i = 1; i <= 10; i++) expect(take(i, 0)).toBeNull();
    expect(countGateSlots(store, 1)).toBe(0);
  });

  it('reaps a stale slot (dead window) but keeps a touched one', () => {
    const dead = take(1, 2)!;
    const live = take(2, 2)!;
    age(dead, 300);
    age(live, 300);
    expect(touchGateSlot(store, live)).toBe(true);
    expect(reapStaleGateSlots(store, 120_000, 1)).toBe(1);
    expect(touchGateSlot(store, dead)).toBe(false);
    expect(take(3, 2)).not.toBeNull();
  });

  it('does not reap another project', () => {
    const other = take(1, 2, 2)!;
    age(other, 300);
    expect(reapStaleGateSlots(store, 120_000, 1)).toBe(0);
  });
});
