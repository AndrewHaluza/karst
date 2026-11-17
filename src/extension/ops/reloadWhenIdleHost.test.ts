import { afterEach, describe, expect, it, vi } from 'vitest';
import { openStore } from '../../store/db.js';
import { createDrain } from '../../runtime/drain.js';
import { createTicketFlow } from '../../workflow/stages/create.js';
import { openShipRun } from '../../store/shipRuns.js';
import { setDeliverDrain } from './autoDeliverOps.js';
import { setHeadlessDrain } from '../../agent/headlessSpawn.js';
import { RELOAD_WHEN_IDLE_TITLE } from './reloadWhenIdle.js';
import { cancelReloadDrain, drainSignature, drainSnapshot, onDrainChange } from './reloadDrainView.js';
import {
  RELOAD_ALREADY_WAITING_MESSAGE,
  abortableSleep,
  idleProgressMessage,
  installReloadDrain,
  makeReloadWhenIdleHandler,
  type ReloadWhenIdleHost,
} from './reloadWhenIdleHost.js';

vi.mock('./autoDeliverOps.js', async (orig) => ({
  ...(await orig<typeof import('./autoDeliverOps.js')>()),
  setDeliverDrain: vi.fn(),
}));
vi.mock('../../agent/headlessSpawn.js', async (orig) => ({
  ...(await orig<typeof import('../../agent/headlessSpawn.js')>()),
  setHeadlessDrain: vi.fn(),
}));

afterEach(() => {
  vi.useRealTimers();
  vi.mocked(setDeliverDrain).mockClear();
  vi.mocked(setHeadlessDrain).mockClear();
});

describe('idleProgressMessage', () => {
  it('says Reloading… at zero', () => expect(idleProgressMessage(0)).toBe('Reloading…'));
  it('uses the singular for one run', () =>
    expect(idleProgressMessage(1)).toBe('Waiting for 1 live run — no new runs start'));
  it('uses the plural for many runs', () =>
    expect(idleProgressMessage(2)).toBe('Waiting for 2 live runs — no new runs start'));
});

describe('idleProgressMessage with named runs', () => {
  it('names each live run by ticket and kind', () =>
    expect(idleProgressMessage(2, [{ ticketId: 1183, kind: 'deliver' }, { ticketId: 1188, kind: 'ship' }])).toBe(
      'Waiting for T1183 deliver, T1188 ship — no new runs start',
    ));
  it('keeps the count form when a run names no ticket', () =>
    expect(idleProgressMessage(2, [{ ticketId: 1183, kind: 'deliver' }, { ticketId: null, kind: 'gate' }])).toBe(
      'Waiting for 2 live runs — no new runs start',
    ));
});

describe('abortableSleep', () => {
  it('resolves after the delay and not before', async () => {
    vi.useFakeTimers();
    const done = vi.fn();
    void abortableSleep(new AbortController().signal)(100).then(done);
    await vi.advanceTimersByTimeAsync(99);
    expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('resolves at once on abort and clears its timer', async () => {
    vi.useFakeTimers();
    const ac = new AbortController();
    const done = vi.fn();
    void abortableSleep(ac.signal)(100000).then(done);
    ac.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('installReloadDrain', () => {
  it('hands the drain to the headless guard', () => {
    const drain = createDrain();
    installReloadDrain(drain);
    expect(setHeadlessDrain).toHaveBeenCalledWith(drain);
  });

  it('makes the deliver probe follow the drain flag', () => {
    const drain = createDrain();
    installReloadDrain(drain);
    const probe = vi.mocked(setDeliverDrain).mock.calls[0]![0]!;
    expect(probe()).toBe(false);
    drain.begin();
    expect(probe()).toBe(true);
  });
});

function fakeHost(over: Partial<ReloadWhenIdleHost> = {}) {
  const reports: string[] = [];
  const informs: string[] = [];
  const titles: string[] = [];
  let cancel: (() => void) | undefined;
  const host: ReloadWhenIdleHost = {
    inform: (m) => void informs.push(m),
    withProgress: async (title, run) => {
      titles.push(title);
      await run((m) => void reports.push(m), (l) => void (cancel = l));
    },
    reloadWindow: vi.fn(async () => {}),
    ...over,
  };
  return { host, reports, informs, titles, cancel: () => cancel?.() };
}

describe('makeReloadWhenIdleHandler', () => {
  it('informs and starts no progress when a reload already waits', async () => {
    const drain = createDrain();
    drain.begin();
    const f = fakeHost();
    await makeReloadWhenIdleHandler(openStore(':memory:'), drain, () => {}, () => {}, f.host)();
    expect(f.informs).toEqual([RELOAD_ALREADY_WAITING_MESSAGE]);
    expect(f.titles).toEqual([]);
    expect(f.host.reloadWindow).not.toHaveBeenCalled();
  });

  it('reloads at once with no live run, under the command title', async () => {
    const f = fakeHost();
    await makeReloadWhenIdleHandler(openStore(':memory:'), createDrain(), () => {}, () => {}, f.host)();
    expect(f.titles).toEqual([RELOAD_WHEN_IDLE_TITLE]);
    expect(f.reports).toEqual(['Reloading…']);
    expect(f.host.reloadWindow).toHaveBeenCalledTimes(1);
    expect(f.informs).toEqual([]);
  });

  it('counts a tracked run and a ship run of this pid, then cancels and re-drives held tickets', async () => {
    const store = openStore(':memory:');
    const drain = createDrain();
    const redrive = vi.fn();
    const logs: string[] = [];
    const f = fakeHost();
    let release!: () => void;
    const tracked = drain.track(() => new Promise<void>((r) => (release = r)));
    const run = makeReloadWhenIdleHandler(store, drain, (m) => logs.push(m), redrive, f.host, 4242)();
    await new Promise((r) => setTimeout(r, 10));
    expect(drain.isDraining()).toBe(true);
    expect(f.reports).toEqual(['Waiting for 1 live run — no new runs start']);
    drain.hold(9);
    f.cancel();
    await run;
    release();
    await tracked;
    expect(drain.isDraining()).toBe(false);
    expect(redrive).toHaveBeenCalledWith(9);
    expect(f.host.reloadWindow).not.toHaveBeenCalled();
    expect(logs.some((l) => l.includes('cancelled'))).toBe(true);
  });

  it('counts a running ship run of the host pid and ignores another pid', async () => {
    const store = openStore(':memory:');
    const drain = createDrain();
    const t = createTicketFlow(store, { key: 'K-1', title: 't' });
    openShipRun(store, { ticketId: t.id, attempt: 1, startedAt: 'x', pid: 4242 });
    const f = fakeHost();
    const run = makeReloadWhenIdleHandler(store, drain, () => {}, () => {}, f.host, 4242)();
    await new Promise((r) => setTimeout(r, 10));
    expect(f.reports).toEqual([`Waiting for T${t.id} ship — no new runs start`]);
    f.cancel();
    await run;
    const other = fakeHost();
    await makeReloadWhenIdleHandler(store, createDrain(), () => {}, () => {}, other.host, 1)();
    expect(other.reports).toEqual(['Reloading…']);
  });

  it('binds a snapshot of the live runs and held tickets, cancels through the dashboard seam, and unbinds after', async () => {
    const store = openStore(':memory:');
    const drain = createDrain();
    const t = createTicketFlow(store, { key: 'K-5', title: 't' });
    openShipRun(store, { ticketId: t.id, attempt: 1, startedAt: 'x', pid: 4242 });
    const f = fakeHost();
    const changes = vi.fn();
    const off = onDrainChange(changes);
    const redrive = vi.fn();
    const run = makeReloadWhenIdleHandler(store, drain, () => {}, redrive, f.host, 4242)();
    await new Promise((r) => setTimeout(r, 10));
    drain.hold(t.id);
    expect(drainSnapshot()).toEqual({ draining: true, live: [{ ticketId: t.id, kind: 'ship' }], held: [t.id] });
    expect(f.reports).toEqual([`Waiting for T${t.id} ship — no new runs start`]);
    expect(changes).toHaveBeenCalled();
    expect(cancelReloadDrain()).toBe(true);
    await run;
    expect(redrive).toHaveBeenCalledWith(t.id);
    expect(drain.isDraining()).toBe(false);
    expect(drainSnapshot().draining).toBe(false);
    expect(cancelReloadDrain()).toBe(false);
    off();
  });

  it('notifies a listener when the held tickets change between two polls', async () => {
    vi.useFakeTimers();
    const store = openStore(':memory:');
    const drain = createDrain();
    const f = fakeHost();
    const sigs: string[] = [];
    const off = onDrainChange(() => sigs.push(drainSignature(drainSnapshot())));
    const tracked = drain.track(() => new Promise<void>(() => {}));
    void tracked;
    void makeReloadWhenIdleHandler(store, drain, () => {}, () => {}, f.host, 4242)();
    await vi.advanceTimersByTimeAsync(10);
    const before = sigs.length;
    drain.hold(3);
    await vi.advanceTimersByTimeAsync(2100);
    expect(sigs.length).toBeGreaterThan(before);
    expect(sigs[sigs.length - 1]).toContain('[3]');
    cancelReloadDrain();
    await vi.advanceTimersByTimeAsync(10);
    off();
  });
});
