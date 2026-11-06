import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { upsertProject } from '../store/projects.js';
import { createTicket } from '../store/tickets.js';
import { listMemoryQueue } from '../store/memoryQueue.js';
import type { AttributedRow, Inventory } from '../runtime/resourceInventory.js';
import { bindMemory, isSbxLaunch, type MemoryBinding } from './memoryBinding.js';

const GB = 1024 ** 3;
let store: Store;
let id: number;
let free = 0;
let binding: MemoryBinding | undefined;
const opened: number[] = [];

function bind(infoActions?: (m: string, a: readonly string[]) => Promise<string | undefined>, projectId?: () => number | undefined) {
  binding = bindMemory({
    store, notify: { info: vi.fn(), warn: vi.fn(), error: async () => undefined, ...(infoActions ? { infoActions } : {}) }, manifest: () => undefined,
    freeBytes: async () => free, label: () => 'T1', refresh: () => undefined, openSession: async (t) => { opened.push(t); },
    inventory: () => null, ownedSessions: () => [], stopSandbox: async () => undefined, debug: () => undefined, sweepMs: 10, pressureMs: 1e9, ...(projectId ? { projectId } : {}),
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

  it('a dismissed notice can be re-offered, and Cancel then leaves the queue', async () => {
    free = 0.2 * GB;
    const answers: (string | undefined)[] = [undefined, 'Cancel'];
    const b = bind(async () => answers.shift());
    expect(await b.admitLaunch(id)).toBe(false);
    b.resolveWait();
    await vi.waitFor(() => expect(listMemoryQueue(store)).toEqual([]));
    expect(answers).toEqual([]);
  });

  it('resolveWait never offers a ticket of another project', async () => {
    free = 0.2 * GB;
    const other = createTicket(store, { key: 'O-1', title: 't', projectId: upsertProject(store, { slug: 'q' }).id }).id;
    const infoActions = vi.fn(async () => undefined);
    const b = bind(infoActions, () => (store.db.prepare('SELECT project_id AS p FROM tickets WHERE id = ?').get(id) as { p: number }).p);
    await b.admitLaunch(other);
    infoActions.mockClear();
    b.resolveWait(other);
    expect(infoActions).not.toHaveBeenCalled();
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

describe('bindMemory default liveness check', () => {
  const failWith = (code: string) => () => { throw Object.assign(new Error(code), { code }); };
  const bindDefault = (): void => {
    store.db.prepare("UPDATE tickets SET memory_wait = 1, memory_wait_owner = '4242', memory_wait_at = strftime('%Y-%m-%d %H:%M:%f', 'now', '-1 hour') WHERE id = ?").run(id);
    free = 4 * GB;
    binding = bindMemory({
      store, notify: { info: vi.fn(), warn: vi.fn(), error: async () => undefined }, manifest: () => undefined, owner: '100',
      freeBytes: async () => free, label: () => 'T1', refresh: () => undefined, openSession: async (t) => { opened.push(t); },
      inventory: () => null, ownedSessions: () => [], stopSandbox: async () => undefined, debug: () => undefined, sweepMs: 10, pressureMs: 1e9,
    });
  };
  afterEach(() => { vi.restoreAllMocks(); });

  it('probes the owner pid with signal 0 and leaves a live window its ticket', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    bindDefault();
    await vi.waitFor(() => expect(kill).toHaveBeenCalledWith(4242, 0));
    await new Promise((r) => setTimeout(r, 40));
    expect(opened).toEqual([]);
  });

  it('treats EPERM as alive: the process exists under another user', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(failWith('EPERM'));
    bindDefault();
    await vi.waitFor(() => expect(kill).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 40));
    expect(opened).toEqual([]);
  });

  it('treats ESRCH as gone and adopts the ticket', async () => {
    vi.spyOn(process, 'kill').mockImplementation(failWith('ESRCH'));
    bindDefault();
    await vi.waitFor(() => expect(opened).toEqual([id]));
  });
});

describe('bindMemory pressure warning', () => {
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 40));
  const row = (over: Partial<AttributedRow> & { rss?: number }): AttributedRow => {
    const { rss = GB, ...rest } = over;
    return { pid: 0, kind: 'container', ticketId: 7, label: 'web', serverId: null, cost: { rssBytes: rss }, cwd: null, comm: 'c', ...rest } as AttributedRow;
  };
  const inv = (attributed: AttributedRow[], vmRss?: number): Inventory =>
    ({ attributed, ...(vmRss === undefined ? {} : { vmOverhead: { rssBytes: vmRss, cpuPct: null, procCount: 1 } }) }) as Inventory;

  function watch(o: {
    inventory: () => Inventory | null;
    answer?: string;
    noActions?: boolean;
    owned?: number[];
    freeBytes?: () => Promise<number>;
    stopSandbox?: (t: number) => Promise<void>;
  }) {
    const infoActions = vi.fn(async (_m: string, _a: readonly string[]) => o.answer);
    const warn = vi.fn();
    const debug = vi.fn();
    const stopSandbox = vi.fn(o.stopSandbox ?? (async () => undefined));
    const inventory = vi.fn(o.inventory);
    const b = bindMemory({
      store, notify: { info: vi.fn(), warn, error: async () => undefined, ...(o.noActions ? {} : { infoActions }) }, manifest: () => undefined,
      freeBytes: o.freeBytes ?? (async () => free), label: (t) => `T${t}`, refresh: () => undefined, openSession: async () => undefined,
      inventory, ownedSessions: () => o.owned ?? [], stopSandbox, debug, sweepMs: 1e9, pressureMs: 5,
    });
    binding = b;
    return { b, infoActions, warn, debug, stopSandbox, inventory };
  }
  /** A negative assertion proves nothing until a tick has run: wait for a second tick, then let the first one finish. */
  const ticked = async (w: { inventory: ReturnType<typeof vi.fn> }): Promise<void> => {
    await vi.waitFor(() => expect(w.inventory.mock.calls.length).toBeGreaterThan(1));
    await settle();
  };
  const message = (w: { infoActions: ReturnType<typeof vi.fn> }): string => w.infoActions.mock.calls[0]![0] as string;

  it('names the largest container row with a ticket and a cost, and offers Stop', async () => {
    free = 0.2 * GB;
    const w = watch({ inventory: () => inv([
      row({ ticketId: 8, label: 'db', rss: GB }),
      row({ rss: 3 * GB }),
      row({ kind: 'session', ticketId: 9, label: 'host', rss: 9 * GB }),
      row({ ticketId: null, label: 'orphan', rss: 9 * GB }),
      row({ ticketId: 10, label: 'unsampled', cost: null }),
    ], 20 * GB) });
    await vi.waitFor(() => expect(w.infoActions).toHaveBeenCalled());
    expect(message(w)).toContain('Sandbox web uses the most (3.0 GB)');
    expect(w.infoActions.mock.calls[0]![1]).toEqual(['Stop']);
  });

  it('names a container row with no label by its ticket', async () => {
    free = 0.2 * GB;
    const w = watch({ inventory: () => inv([row({ label: null, rss: 2 * GB })]) });
    await vi.waitFor(() => expect(w.infoActions).toHaveBeenCalled());
    expect(message(w)).toContain('Sandbox ticket 7 uses the most (2.0 GB)');
  });

  it('with no container row, splits the VM overhead over the sbx sessions and skips host sessions', async () => {
    free = 4 * GB;
    const second = createTicket(store, { key: 'B-2', title: 't', projectId: upsertProject(store, { slug: 'p' }).id }).id;
    const w = watch({ inventory: () => inv([], 4 * GB), owned: [id, second, 999] });
    await w.b.admitLaunch(id);
    await w.b.admitLaunch(second);
    free = 0.2 * GB;
    await vi.waitFor(() => expect(w.infoActions).toHaveBeenCalled());
    expect(message(w)).toContain(`Sandbox T${id} uses the most (2.0 GB)`);
    expect(message(w)).not.toContain('T999');
  });

  const silentCases: [string, () => Inventory | null, boolean][] = [
    ['no inventory', () => null, true],
    ['an owned sbx session but no VM', () => inv([]), true],
    ['a VM but an owned session that did not launch through the gate', () => inv([], 4 * GB), false],
  ];
  it.each(silentCases)('stays silent with %s', async (_name, inventory, admit) => {
    free = 4 * GB;
    const w = watch({ inventory, owned: [id] });
    if (admit) await w.b.admitLaunch(id);
    free = 0.2 * GB;
    await ticked(w);
    expect(w.infoActions).not.toHaveBeenCalled();
    expect(w.debug).not.toHaveBeenCalled();
  });

  it('stays silent while memory is free', async () => {
    free = 40 * GB;
    const w = watch({ inventory: () => inv([row({})]) });
    await ticked(w);
    expect(w.infoActions).not.toHaveBeenCalled();
  });

  it('Stop stops the named sandbox', async () => {
    free = 0.2 * GB;
    const w = watch({ inventory: () => inv([row({})]), answer: 'Stop' });
    await vi.waitFor(() => expect(w.stopSandbox).toHaveBeenCalledWith(7));
    expect(w.warn).not.toHaveBeenCalled();
  });

  it.each([
    ['dismisses the warning', { answer: undefined }],
    ['has no action buttons', { noActions: true }],
  ])('stops nothing when the host %s', async (_name, extra) => {
    free = 0.2 * GB;
    const w = watch({ inventory: () => inv([row({})]), ...extra });
    await ticked(w);
    expect(w.infoActions).toHaveBeenCalledTimes('noActions' in extra ? 0 : 1);
    expect(w.stopSandbox).not.toHaveBeenCalled();
    expect(w.debug).not.toHaveBeenCalled();
  });

  it('warns when the stop fails, with the error cut to 300 characters', async () => {
    free = 0.2 * GB;
    const w = watch({ inventory: () => inv([row({})]), answer: 'Stop', stopSandbox: async () => { throw new Error('x'.repeat(400)); } });
    await vi.waitFor(() => expect(w.warn).toHaveBeenCalled());
    expect(w.warn).toHaveBeenCalledWith(`Karst: could not stop web: ${`Error: ${'x'.repeat(400)}`.slice(0, 300)}`);
  });

  it('logs a failed tick', async () => {
    const w = watch({ inventory: () => inv([row({})]), freeBytes: async () => { throw new Error('no vm_stat'); } });
    await vi.waitFor(() => expect(w.debug).toHaveBeenCalledWith('[memory-pressure] tick failed: Error: no vm_stat'));
  });

  it('dispose stops the pressure timer', async () => {
    free = 40 * GB;
    const inventory = vi.fn(() => null);
    const w = watch({ inventory });
    await vi.waitFor(() => expect(inventory).toHaveBeenCalled());
    w.b.dispose();
    inventory.mockClear();
    await settle();
    expect(inventory).not.toHaveBeenCalled();
  });
});

describe('isSbxLaunch', () => {
  it('gates sbx cores only, never Docker or host', () => {
    expect(isSbxLaunch('claude')).toBe(true);
    expect(isSbxLaunch('opencode')).toBe(false);
    expect(isSbxLaunch(null)).toBe(false);
  });
});
