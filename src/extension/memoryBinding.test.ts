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

describe('isSbxLaunch', () => {
  it('gates sbx cores only, never Docker or host', () => {
    expect(isSbxLaunch('claude')).toBe(true);
    expect(isSbxLaunch('opencode')).toBe(false);
    expect(isSbxLaunch(null)).toBe(false);
  });
});
