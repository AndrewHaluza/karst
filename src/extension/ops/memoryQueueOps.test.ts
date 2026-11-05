import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { upsertProject } from '../../store/projects.js';
import { createTicket } from '../../store/tickets.js';
import { listMemoryQueue, memoryWaitNotes } from '../../store/memoryQueue.js';
import { makeMemoryQueue, type StartResult } from './memoryQueueOps.js';

const GB = 1024 ** 3;
let store: Store;
let projectId: number;
let free = 0;
const started: number[] = [];
let reads = 0;

const ticket = (n: number): number => createTicket(store, { key: `Q-${n}`, title: 't', projectId }).id;
const make = (start: (id: number) => Promise<StartResult> = async (id) => { started.push(id); return { ok: true }; }) => {
  const warn = vi.fn();
  const q = makeMemoryQueue({
    store, freeBytes: async () => { reads += 1; return free; }, minFreeBytes: () => 1.5 * GB, start,
    label: (id) => `T${id}`, notify: { info: vi.fn(), warn, error: async () => undefined },
  });
  return { q, warn };
};

beforeEach(() => {
  store = openStore(':memory:');
  projectId = upsertProject(store, { slug: 'p' }).id;
  started.length = 0;
  reads = 0;
});
afterEach(() => store.close());

describe('memory queue ops', () => {
  it('admits when memory is free and queues (not refuses) when it is short', async () => {
    const a = ticket(1);
    free = 4 * GB;
    expect(await make().q.admit(a)).toEqual({ admitted: true });
    free = 0.8 * GB;
    const out = await make().q.admit(a);
    expect(out).toEqual({ admitted: false, note: 'Waiting for memory (free 0.8 GB, needs 1.5 GB)' });
    expect(memoryWaitNotes(store).get(a)).toBe(out.admitted ? '' : out.note);
  });

  it('starts one waiter per sweep, oldest first, re-reading free memory each time', async () => {
    const a = ticket(1), b = ticket(2);
    free = 0.1 * GB;
    const { q } = make();
    await q.admit(a);
    store.db.prepare("UPDATE tickets SET memory_wait_at = '2026-01-01 00:00:00.000' WHERE id = ?").run(a);
    await q.admit(b);
    store.db.prepare("UPDATE tickets SET memory_wait_at = '2026-01-01 00:00:09.000' WHERE id = ?").run(b);
    reads = 0;
    expect(await q.sweep()).toBeNull(); // still short: nothing starts, note refreshed
    expect(started).toEqual([]);
    free = 3 * GB;
    expect(await q.sweep()).toBe(a);
    expect(started).toEqual([a]);
    expect(await q.sweep()).toBe(b);
    expect(started).toEqual([a, b]);
    expect(reads).toBe(3);
    expect(listMemoryQueue(store)).toEqual([]);
  });

  it('a failed start leaves the queue and warns once', async () => {
    const a = ticket(1);
    free = 0;
    const { q, warn } = make(async () => ({ ok: false, message: 'sbx down' }));
    await q.admit(a);
    free = 3 * GB;
    expect(await q.sweep()).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
    expect(listMemoryQueue(store)).toEqual([]);
  });

  it('Start anyway skips the memory check; Cancel leaves without starting', async () => {
    const a = ticket(1), b = ticket(2);
    free = 0;
    const { q } = make();
    await q.admit(a);
    await q.admit(b);
    expect((await q.startAnyway(a)).ok).toBe(true);
    expect(started).toEqual([a]);
    q.cancel(b);
    expect(listMemoryQueue(store)).toEqual([]);
    expect(started).toEqual([a]);
  });

  it('waits for the settle window between starts, so the whole queue is not released at once', async () => {
    let t = 0;
    const q = makeMemoryQueue({
      store, freeBytes: async () => GB * 8, minFreeBytes: () => 1.5 * GB, settleMs: 60_000, now: () => t,
      start: async (id) => { started.push(id); return { ok: true }; }, label: (id) => `T${id}`, notify: { info: vi.fn(), warn: vi.fn(), error: async () => undefined },
    });
    const a = ticket(), b = ticket();
    free = 0;
    await make().q.admit(a); await make().q.admit(b);
    expect(await q.sweep()).toBe(a);
    t = 10_000;
    expect(await q.sweep()).toBeNull();
    t = 61_000;
    expect(await q.sweep()).toBe(b);
  });

  it('drops the row of a ticket that already has a session instead of starting it again', async () => {
    const q = makeMemoryQueue({
      store, freeBytes: async () => GB * 8, minFreeBytes: () => 1.5 * GB, hasSession: () => true,
      start: async (id) => { started.push(id); return { ok: true }; }, label: (id) => `T${id}`, notify: { info: vi.fn(), warn: vi.fn(), error: async () => undefined },
    });
    const a = ticket();
    free = 0;
    await make().q.admit(a);
    expect(await q.sweep()).toBeNull();
    expect(started).toEqual([]);
    expect(listMemoryQueue(store)).toEqual([]);
  });

  it('a launch that is admitted clears a stale queue row', async () => {
    const a = ticket();
    free = 0;
    const { q } = make();
    await q.admit(a);
    free = 8 * GB;
    expect((await q.admit(a)).admitted).toBe(true);
    expect(listMemoryQueue(store)).toEqual([]);
  });

  it('only starts tickets of this window\'s project', async () => {
    const other = upsertProject(store, { slug: 'o2' }).id;
    const x = createTicket(store, { key: 'X-9', title: 't', projectId: other }).id;
    free = 0;
    await make().q.admit(x);
    const q = makeMemoryQueue({
      store, freeBytes: async () => GB * 8, minFreeBytes: () => 1.5 * GB, projectId: () => projectId,
      start: async (id) => { started.push(id); return { ok: true }; }, label: (id) => `T${id}`, notify: { info: vi.fn(), warn: vi.fn(), error: async () => undefined },
    });
    expect(await q.sweep()).toBeNull();
    expect(started).toEqual([]);
  });
});
