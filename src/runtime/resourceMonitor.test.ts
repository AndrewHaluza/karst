import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import type { ProcRecord, ProcSnapshot } from './procSnapshot.js';
import type { ProcessFactsSource } from './serverIdentity.js';
import { HEAVY_RSS_BYTES } from './resourceInventory.js';
import { killTree } from './processTree.js';
import {
  FAST_LANE_INTERVAL_MS,
  ResourceMonitor,
  RING_CAPACITY,
  SLOW_LANE_INTERVAL_MS,
  type ResourceMonitorDeps,
} from './resourceMonitor.js';

vi.mock('./processTree.js', () => ({ killTree: vi.fn() }));

function rec(
  pid: number,
  ppid: number,
  rssBytes: number,
  cpuSeconds: number,
  startedMs: number | null,
): ProcRecord {
  return { pid, ppid, rssBytes, cpuSeconds, startedMs, comm: `p${pid}` };
}

function makeSnapshot(takenMs: number, recs: ProcRecord[] = []): ProcSnapshot {
  const records = new Map<number, ProcRecord>();
  const children = new Map<number, number[]>();
  for (const r of recs) {
    records.set(r.pid, r);
    const list = children.get(r.ppid) ?? [];
    list.push(r.pid);
    children.set(r.ppid, list);
  }
  return { takenMs, records, children };
}

function makeFacts(): ProcessFactsSource & {
  isAlive: ReturnType<typeof vi.fn>;
  liveCwd: ReturnType<typeof vi.fn>;
  processStartMs: ReturnType<typeof vi.fn>;
} {
  return {
    isAlive: vi.fn(() => true),
    liveCwd: vi.fn(() => ({ path: '/tmp/wt/x', deleted: false })),
    processStartMs: vi.fn(() => 1_000),
  };
}

function seedServer(store: Store, pid = 4242): void {
  store.db
    .prepare(
      `INSERT INTO servers (ticket_id, repo, host, port, pid, status, log_path, started_at, cwd)
       VALUES (NULL, 'web', 'localhost', 5173, ?, 'running', '/tmp/x.log', '2026-08-12T10:00:00.000Z', '/tmp/wt/x')`,
    )
    .run(pid);
}

const okSnapshot = (): { supported: true; snapshot: ProcSnapshot } => ({
  supported: true,
  snapshot: makeSnapshot(1_000, [rec(1, 0, 10, 1, 1)]),
});

describe('ResourceMonitor', () => {
  let store: Store;
  beforeEach(() => {
    vi.useFakeTimers();
    store = openStore(':memory:');
  });
  afterEach(() => {
    vi.useRealTimers();
    store.close();
  });

  function makeDeps(overrides: Partial<ResourceMonitorDeps> = {}): ResourceMonitorDeps {
    return {
      store,
      projectId: () => undefined,
      worktreeRoots: () => [],
      facts: makeFacts(),
      readSnapshot: vi.fn(async () => okSnapshot()) as unknown as ResourceMonitorDeps['readSnapshot'],
      debug: vi.fn(),
      logError: vi.fn(),
      ...overrides,
    };
  }

  it('runs the slow lane every 30s and the fast lane every 2s only after setPanelVisible(true)', async () => {
    const readSnapshot = vi.fn(async () => okSnapshot()) as unknown as ResourceMonitorDeps['readSnapshot'];
    const monitor = new ResourceMonitor(makeDeps({ readSnapshot }));
    monitor.start();
    expect(readSnapshot).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(SLOW_LANE_INTERVAL_MS - 1);
    expect(readSnapshot).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(readSnapshot).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(FAST_LANE_INTERVAL_MS * 5);
    expect(readSnapshot).toHaveBeenCalledTimes(1);
    monitor.setPanelVisible(true);
    await vi.advanceTimersByTimeAsync(FAST_LANE_INTERVAL_MS);
    expect(readSnapshot).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(FAST_LANE_INTERVAL_MS);
    expect(readSnapshot).toHaveBeenCalledTimes(3);
    monitor.dispose();
  });

  it('stops the fast lane on setPanelVisible(false)', async () => {
    const readSnapshot = vi.fn(async () => okSnapshot());
    const monitor = new ResourceMonitor(
      makeDeps({ readSnapshot: readSnapshot as unknown as ResourceMonitorDeps['readSnapshot'] }),
    );
    monitor.start();
    await vi.advanceTimersByTimeAsync(SLOW_LANE_INTERVAL_MS);
    monitor.setPanelVisible(true);
    await vi.advanceTimersByTimeAsync(FAST_LANE_INTERVAL_MS);
    const count = readSnapshot.mock.calls.length;
    monitor.setPanelVisible(false);
    await vi.advanceTimersByTimeAsync(FAST_LANE_INTERVAL_MS * 5);
    expect(readSnapshot.mock.calls.length).toBe(count);
    monitor.dispose();
  });

  it('probes cwds on the slow lane and never on the fast lane', async () => {
    const readSnapshot = vi.fn(async () => ({
      supported: true,
      snapshot: makeSnapshot(1_000, [
        rec(900, 0, HEAVY_RSS_BYTES + 1, 1, 1),
        rec(process.pid, 0, 10, 1, 1),
      ]),
    })) as unknown as ResourceMonitorDeps['readSnapshot'];
    const facts = makeFacts();
    const monitor = new ResourceMonitor(makeDeps({ readSnapshot, facts }));
    monitor.start();
    await vi.advanceTimersByTimeAsync(SLOW_LANE_INTERVAL_MS);
    expect(facts.liveCwd).toHaveBeenCalled();
    const slowProbeCount = facts.liveCwd.mock.calls.length;
    monitor.setPanelVisible(true);
    await vi.advanceTimersByTimeAsync(FAST_LANE_INTERVAL_MS * 5);
    expect(facts.liveCwd.mock.calls.length).toBe(slowProbeCount);
    monitor.dispose();
  });

  it('skips a tick while one is in flight instead of queuing it', async () => {
    let resolveSnap!: (r: { supported: true; snapshot: ProcSnapshot }) => void;
    const readSnapshot = vi.fn(
      () =>
        new Promise<{ supported: true; snapshot: ProcSnapshot }>((resolve) => {
          resolveSnap = resolve;
        }),
    ) as unknown as ResourceMonitorDeps['readSnapshot'];
    const debug = vi.fn();
    const monitor = new ResourceMonitor(makeDeps({ readSnapshot, debug }));
    monitor.start();
    const p = monitor.refreshNow();
    await vi.advanceTimersByTimeAsync(SLOW_LANE_INTERVAL_MS);
    expect(readSnapshot).toHaveBeenCalledTimes(1);
    expect(debug.mock.calls.some(([m]) => String(m).includes('tick skipped'))).toBe(true);
    resolveSnap(okSnapshot());
    await p;
    await vi.advanceTimersByTimeAsync(SLOW_LANE_INTERVAL_MS);
    expect(readSnapshot).toHaveBeenCalledTimes(2);
    monitor.dispose();
  });

  it('reports unsupported and stops all ticking', async () => {
    const readSnapshot = vi.fn(async () => ({ supported: false })) as unknown as ResourceMonitorDeps['readSnapshot'];
    const monitor = new ResourceMonitor(makeDeps({ readSnapshot }));
    monitor.start();
    await vi.advanceTimersByTimeAsync(SLOW_LANE_INTERVAL_MS);
    expect(monitor.reading().supported).toBe(false);
    await vi.advanceTimersByTimeAsync(SLOW_LANE_INTERVAL_MS * 3);
    expect(readSnapshot).toHaveBeenCalledTimes(1);
  });

  it('exposes the skipped-tick counter and the fast-lane state on the reading', async () => {
    let resolveSnap!: (r: { supported: true; snapshot: ProcSnapshot }) => void;
    const readSnapshot = vi.fn(
      () =>
        new Promise<{ supported: true; snapshot: ProcSnapshot }>((resolve) => {
          resolveSnap = resolve;
        }),
    ) as unknown as ResourceMonitorDeps['readSnapshot'];
    const monitor = new ResourceMonitor(makeDeps({ readSnapshot }));
    monitor.start();
    const p = monitor.refreshNow();
    await vi.advanceTimersByTimeAsync(SLOW_LANE_INTERVAL_MS);
    expect(monitor.reading().fastLane).toBe(false);
    monitor.setPanelVisible(true);
    await vi.advanceTimersByTimeAsync(FAST_LANE_INTERVAL_MS);
    expect(monitor.reading().fastLane).toBe(true);
    expect(monitor.reading().skipped).toBeGreaterThan(0);
    resolveSnap(okSnapshot());
    await p;
    monitor.dispose();
  });

  it('reports a clean reading with zero skipped ticks after an uninterrupted tick', async () => {
    const monitor = new ResourceMonitor(makeDeps({}));
    await monitor.refreshNow();
    const reading = monitor.reading();
    expect(reading.skipped).toBe(0);
    expect(reading.fastLane).toBe(false);
    monitor.dispose();
  });

  it('sets degraded on a null snapshot and retains the previous inventory', async () => {
    let call = 0;
    const readSnapshot = vi.fn(async () => {
      call += 1;
      if (call === 1) return okSnapshot();
      return { supported: true, snapshot: null };
    }) as unknown as ResourceMonitorDeps['readSnapshot'];
    const monitor = new ResourceMonitor(makeDeps({ readSnapshot }));
    monitor.start();
    await vi.advanceTimersByTimeAsync(SLOW_LANE_INTERVAL_MS);
    const inv = monitor.reading().inventory;
    expect(inv).not.toBeNull();
    await vi.advanceTimersByTimeAsync(SLOW_LANE_INTERVAL_MS);
    const reading = monitor.reading();
    expect(reading.degraded).toBe(true);
    expect(reading.inventory).toBe(inv);
    monitor.dispose();
  });

  it('never lets the ring exceed RING_CAPACITY', async () => {
    const monitor = new ResourceMonitor(makeDeps({}));
    monitor.start();
    for (let i = 0; i < RING_CAPACITY + 5; i += 1) await monitor.refreshNow();
    expect(monitor.reading().history.length).toBe(RING_CAPACITY);
    monitor.dispose();
  });

  it('a throwing listener does not prevent the others from being notified', async () => {
    const logError = vi.fn();
    const monitor = new ResourceMonitor(makeDeps({ logError }));
    const good = vi.fn();
    const bad = vi.fn(() => {
      throw new Error('listener boom');
    });
    monitor.onReading(bad);
    monitor.onReading(good);
    await monitor.refreshNow();
    expect(good).toHaveBeenCalledTimes(1);
    expect(logError).toHaveBeenCalledTimes(1);
  });

  it('a thrown tick reaches logError and retains the previous reading', async () => {
    let mode: 'throw' | 'ok' = 'throw';
    const readSnapshot = vi.fn(async () => {
      if (mode === 'throw') throw new Error('ps broken');
      return okSnapshot();
    }) as unknown as ResourceMonitorDeps['readSnapshot'];
    const logError = vi.fn();
    const monitor = new ResourceMonitor(makeDeps({ readSnapshot, logError }));
    await monitor.refreshNow();
    expect(monitor.reading().inventory).toBeNull();
    expect(logError).toHaveBeenCalledTimes(1);
    mode = 'ok';
    await monitor.refreshNow();
    const inv = monitor.reading().inventory;
    expect(inv).not.toBeNull();
    mode = 'throw';
    await monitor.refreshNow();
    expect(monitor.reading().inventory).toBe(inv);
    expect(logError).toHaveBeenCalledTimes(2);
  });

  it('kill on a foreign attribution returns not-attributable and never signals', async () => {
    const facts = makeFacts();
    facts.liveCwd.mockReturnValue({ path: '/other', deleted: false });
    const monitor = new ResourceMonitor(makeDeps({ facts }));
    seedServer(store);
    vi.mocked(killTree).mockClear();
    const outcome = await monitor.kill(1);
    expect(outcome).toBe('not-attributable');
    expect(killTree).not.toHaveBeenCalled();
    const row = store.db.prepare('SELECT status, pid FROM servers WHERE id = 1').get() as {
      status: string;
      pid: number | null;
    };
    expect(row.status).toBe('running');
    expect(row.pid).toBe(4242);
  });

  it('kill on an attributable row signals and marks the row stopped', async () => {
    const monitor = new ResourceMonitor(makeDeps({}));
    seedServer(store);
    vi.mocked(killTree).mockReturnValue('killed');
    const outcome = await monitor.kill(1);
    expect(outcome).toBe('killed');
    expect(killTree).toHaveBeenCalledWith(4242);
    const row = store.db.prepare('SELECT status, pid FROM servers WHERE id = 1').get() as {
      status: string;
      pid: number | null;
    };
    expect(row.status).toBe('stopped');
    expect(row.pid).toBeNull();
  });

  it('kill returning denied leaves the row running', async () => {
    const monitor = new ResourceMonitor(makeDeps({}));
    seedServer(store);
    vi.mocked(killTree).mockReturnValue('denied');
    const outcome = await monitor.kill(1);
    expect(outcome).toBe('denied');
    const row = store.db.prepare('SELECT status, pid FROM servers WHERE id = 1').get() as {
      status: string;
      pid: number | null;
    };
    expect(row.status).toBe('running');
    expect(row.pid).toBe(4242);
  });

  it('kill for a serverId whose row is gone returns not-attributable without signalling', async () => {
    const monitor = new ResourceMonitor(makeDeps({}));
    vi.mocked(killTree).mockClear();
    const outcome = await monitor.kill(999);
    expect(outcome).toBe('not-attributable');
    expect(killTree).not.toHaveBeenCalled();
  });

  it('setPanelVisible(true) on an unsupported platform creates no interval', async () => {
    const readSnapshot = vi.fn(async () => ({ supported: false })) as unknown as ResourceMonitorDeps['readSnapshot'];
    const monitor = new ResourceMonitor(makeDeps({ readSnapshot }));
    monitor.start();
    await vi.advanceTimersByTimeAsync(SLOW_LANE_INTERVAL_MS);
    expect(monitor.reading().supported).toBe(false);
    monitor.setPanelVisible(true);
    await vi.advanceTimersByTimeAsync(FAST_LANE_INTERVAL_MS * 5);
    expect(readSnapshot).toHaveBeenCalledTimes(1);
  });
});
