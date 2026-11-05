import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStore, type Store } from './db.js';
import { upsertProject } from './projects.js';
import { createTicket } from './tickets.js';
import { claimMemoryWait, clearMemoryWait, listMemoryQueue, memoryWaitNotes, queueMemoryWait, requeueStaleMemoryClaims } from './memoryQueue.js';

let store: Store;
let projectId: number;
let n = 0;
const ticket = (): number => createTicket(store, { key: `M-${++n}`, title: 't', projectId }).id;
const state = (id: number): number => (store.db.prepare('SELECT memory_wait AS w FROM tickets WHERE id = ?').get(id) as { w: number }).w;
const stamp = (id: number, at: string): void => void store.db.prepare('UPDATE tickets SET memory_wait_at = ? WHERE id = ?').run(at, id);

beforeEach(() => {
  store = openStore(':memory:');
  projectId = upsertProject(store, { slug: 'p' }).id;
});
afterEach(() => store.close());

describe('memory wait queue', () => {
  it('queues with a note and lists FIFO', () => {
    const a = ticket(), b = ticket();
    queueMemoryWait(store, b, 'Waiting for memory (b)');
    queueMemoryWait(store, a, 'Waiting for memory (a)');
    stamp(b, '2026-01-01 00:00:00.000');
    stamp(a, '2026-01-01 00:00:05.000');
    expect(listMemoryQueue(store)).toEqual([b, a]);
    expect(memoryWaitNotes(store).get(a)).toBe('Waiting for memory (a)');
  });

  it('refreshing the note keeps the place in line', () => {
    const a = ticket(), b = ticket();
    queueMemoryWait(store, a, 'x');
    stamp(a, '2026-01-01 00:00:00.000');
    queueMemoryWait(store, b, 'y');
    stamp(b, '2026-01-01 00:00:01.000');
    queueMemoryWait(store, a, 'x2');
    expect(listMemoryQueue(store)).toEqual([a, b]);
    expect(memoryWaitNotes(store).get(a)).toBe('x2');
  });

  it('claims atomically: only the head of the line, and only once', () => {
    const a = ticket(), b = ticket();
    queueMemoryWait(store, a, 'x');
    queueMemoryWait(store, b, 'x');
    stamp(a, '2026-01-01 00:00:00.000');
    stamp(b, '2026-01-01 00:00:01.000');
    expect(claimMemoryWait(store, b)).toBe(false);
    expect(claimMemoryWait(store, a)).toBe(true);
    expect(claimMemoryWait(store, a)).toBe(false);
    expect(state(a)).toBe(2);
    expect(queueMemoryWait(store, a, 'again')).toBe(false); // a live claim is never touched
    expect(claimMemoryWait(store, b)).toBe(true); // the line moved on
  });

  it('requeues only stale claims, keeping their place', () => {
    const a = ticket(), b = ticket();
    queueMemoryWait(store, a, 'x');
    queueMemoryWait(store, b, 'x');
    claimMemoryWait(store, a);
    expect(requeueStaleMemoryClaims(store, 60_000)).toBe(0);
    store.db.prepare("UPDATE tickets SET memory_claimed_at = datetime('now', '-10 minutes') WHERE id = ?").run(a);
    expect(requeueStaleMemoryClaims(store, 60_000)).toBe(1);
    expect(state(a)).toBe(1);
    expect(listMemoryQueue(store)[0]).toBe(a);
  });

  it('cancel clears any state and the note', () => {
    const a = ticket();
    queueMemoryWait(store, a, 'x');
    clearMemoryWait(store, a);
    expect(state(a)).toBe(0);
    expect(memoryWaitNotes(store).has(a)).toBe(false);
  });
});
