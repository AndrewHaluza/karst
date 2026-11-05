import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { upsertProject } from '../store/projects.js';
import { createTicket } from '../store/tickets.js';
import { listMemoryQueue } from '../store/memoryQueue.js';
import { bindMemory, isSbxLaunch, type MemoryBinding } from './memoryBinding.js';

const GB = 1024 ** 3;
let store: Store;
let id: number;
let free = 0;
let binding: MemoryBinding | undefined;
const opened: number[] = [];

function bind(infoActions?: (m: string, a: readonly string[]) => Promise<string | undefined>) {
  binding = bindMemory({
    store, notify: { info: vi.fn(), warn: vi.fn(), error: async () => undefined, ...(infoActions ? { infoActions } : {}) }, manifest: () => undefined,
    freeBytes: async () => free, label: () => 'T1', refresh: () => undefined, openSession: async (t) => { opened.push(t); },
    inventory: () => null, ownedSessions: () => [], stopSandbox: async () => undefined, debug: () => undefined, sweepMs: 10, pressureMs: 1e9,
  });
  return binding;
}

beforeEach(() => {
  store = openStore(':memory:');
  id = createTicket(store, { key: 'B-1', title: 't', projectId: upsertProject(store, { slug: 'p' }).id }).id;
  opened.length = 0;
});
afterEach(() => { binding?.dispose(); store.close(); });

describe('bindMemory', () => {
  it('lets a launch through when memory is free', async () => {
    free = 4 * GB;
    expect(await bind().admitLaunch(id)).toBe(true);
    expect(listMemoryQueue(store)).toEqual([]);
  });

  it('queues a launch when memory is short, then the sweep reopens it once and its relaunch skips the check', async () => {
    free = 0.2 * GB;
    const b = bind(async () => undefined);
    expect(await b.admitLaunch(id)).toBe(false);
    expect(listMemoryQueue(store)).toEqual([id]);
    free = 4 * GB;
    await vi.waitFor(() => expect(opened).toEqual([id]));
    expect(listMemoryQueue(store)).toEqual([]);
  });

  it('Cancel leaves the queue without starting', async () => {
    free = 0.2 * GB;
    const b = bind(async () => 'Cancel');
    await b.admitLaunch(id);
    await vi.waitFor(() => expect(listMemoryQueue(store)).toEqual([]));
    free = 4 * GB;
    await new Promise((r) => setTimeout(r, 40));
    expect(opened).toEqual([]);
  });
});

describe('bindMemory queue ownership', () => {
  it('a second launch of a queued ticket keeps the first options and shows one notice', async () => {
    free = 0.2 * GB;
    const infoActions = vi.fn(async () => undefined);
    const b = bind(infoActions);
    expect(await b.admitLaunch(id, { reveal: true } as never)).toBe(false);
    expect(await b.admitLaunch(id, { reveal: false } as never)).toBe(false);
    expect(infoActions).toHaveBeenCalledTimes(1);
    free = 4 * GB;
    await vi.waitFor(() => expect(opened).toEqual([id]));
  });

  const queueAs = (owner: string | null): void => {
    store.db.prepare("UPDATE tickets SET memory_wait = 1, memory_wait_owner = ?, memory_wait_at = strftime('%Y-%m-%d %H:%M:%f', 'now', '-1 hour') WHERE id = ?").run(owner, id);
  };
  const bindOwned = (isAlive: (o: string) => boolean): void => {
    binding = bindMemory({
      store, notify: { info: vi.fn(), warn: vi.fn(), error: async () => undefined }, manifest: () => undefined, owner: '100', isAlive,
      freeBytes: async () => free, label: () => 'T1', refresh: () => undefined, openSession: async (t) => { opened.push(t); },
      inventory: () => null, ownedSessions: () => [], stopSandbox: async () => undefined, debug: () => undefined, sweepMs: 10, pressureMs: 1e9,
    });
  };

  it('leaves a ticket queued by a live window to that window', async () => {
    free = 4 * GB;
    queueAs('200');
    bindOwned(() => true);
    await new Promise((r) => setTimeout(r, 60));
    expect(opened).toEqual([]);
    expect(listMemoryQueue(store)).toEqual([id]);
  });

  it('adopts a ticket whose queuing window is gone, so it never blocks the line', async () => {
    free = 4 * GB;
    queueAs('200');
    bindOwned(() => false);
    await vi.waitFor(() => expect(opened).toEqual([id]));
  });

  it('adopts a queued row with no recorded owner', async () => {
    free = 4 * GB;
    queueAs(null);
    bindOwned(() => true);
    await vi.waitFor(() => expect(opened).toEqual([id]));
  });

  it('keeps an adopted row startable after a low-memory sweep refreshed it', async () => {
    free = 0.2 * GB;
    queueAs('200');
    bindOwned(() => false);
    await new Promise((r) => setTimeout(r, 60)); // sweeps refresh the row (owner becomes this window) while memory is short
    free = 4 * GB;
    await vi.waitFor(() => expect(opened).toEqual([id]));
  });

  it('a Start anyway click while a sweep is starting the ticket does not start it twice', async () => {
    free = 0.2 * GB;
    let choose: (v: string) => void = () => undefined;
    const b = bind(() => new Promise<string | undefined>((r) => { choose = r; }));
    await b.admitLaunch(id);
    store.db.prepare('UPDATE tickets SET memory_wait = 2 WHERE id = ?').run(id); // a sweep holds the claim
    choose('Start anyway');
    await new Promise((r) => setTimeout(r, 30));
    expect(opened).toEqual([]);
  });

  it('a late Start anyway on a ticket that left the queue starts nothing', async () => {
    free = 0.2 * GB;
    let choose: (v: string) => void = () => undefined;
    const b = bind(() => new Promise<string | undefined>((r) => { choose = r; }));
    await b.admitLaunch(id);
    store.db.prepare('UPDATE tickets SET memory_wait = 0 WHERE id = ?').run(id);
    choose('Start anyway');
    await new Promise((r) => setTimeout(r, 30));
    expect(opened).toEqual([]);
  });
});

describe('isSbxLaunch', () => {
  it('gates sbx cores only, never Docker or host', () => {
    expect(isSbxLaunch('claude')).toBe(true);
    expect(isSbxLaunch('opencode')).toBe(false);
    expect(isSbxLaunch(null)).toBe(false);
  });
});
