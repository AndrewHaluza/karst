import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import type { ProcRecord, ProcSnapshot } from './procSnapshot.js';
import type { ProcessFactsSource } from './serverIdentity.js';
import { HEAVY_RSS_BYTES } from './resourceInventory.js';
import { FAST_LANE_INTERVAL_MS, ResourceMonitor, SLOW_LANE_INTERVAL_MS, type ResourceMonitorDeps } from './resourceMonitor.js';
import { ResourcesPanelManager, type ResourcesPanel } from '../ui/resources/panel.js';
import type { WorktreeDiskCache } from './worktreeDisk.js';

/**
 * Cost budget this module's design rests on, measured on the target machine
 * during planning (leak-hunter):
 *
 *   ps -Ao pid=,ppid=,rss=,time=,lstart=,comm=  20–30 ms  (a child process; the
 *                                                          extension host's event
 *                                                          loop is untouched)
 *   ps -p <10 pids>                              10 ms    (no cheaper than the
 *                                                          full scan, and it
 *                                                          misses children)
 *   du -sk on one worktree                      65–90 ms warm (100 worktrees
 *                                                          exist today)
 *
 * These tests PROVE the design's claims WITHOUT a real ps/du — every probe is
 * injected — and the assertions are about ORDERING and CALL COUNTS, never
 * wall-clock thresholds: a slow CI machine must not flake them.
 */
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

const okSnapshot = (): { supported: true; snapshot: ProcSnapshot } => ({
  supported: true,
  snapshot: makeSnapshot(1_000, [rec(1, 0, 10, 1, 1)]),
});

function makeFacts(): ProcessFactsSource & { liveCwd: ReturnType<typeof vi.fn> } {
  return {
    isAlive: vi.fn(() => true),
    liveCwd: vi.fn(() => ({ path: '/wt/x', deleted: false })),
    processStartMs: vi.fn(() => 1_000),
  };
}

describe('resource monitor cost budget', () => {
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

  it('leaves the event loop free while a tick runs', async () => {
    vi.useRealTimers();
    const readSnapshot = vi.fn(
      () =>
        new Promise<{ supported: true; snapshot: ProcSnapshot }>((resolve) => {
          setTimeout(() => resolve(okSnapshot()), 50);
        }),
    ) as unknown as ResourceMonitorDeps['readSnapshot'];
    const monitor = new ResourceMonitor(makeDeps({ readSnapshot }));
    let ticks = 0;
    const timer = setInterval(() => (ticks += 1), 5);
    await monitor.refreshNow();
    clearInterval(timer);
    // The event loop ticked while the snapshot read was in flight — the host was
    // not blocked. Ordering, not a duration: any positive count proves it.
    expect(ticks).toBeGreaterThan(0);
  });

  it('issues exactly ONE snapshot read per tick regardless of how many known pids exist', async () => {
    const readSnapshot = vi.fn(async () => okSnapshot()) as unknown as ResourceMonitorDeps['readSnapshot'];
    const monitor = new ResourceMonitor(makeDeps({ readSnapshot }));
    for (let i = 0; i < 50; i += 1) {
      monitor.registerPid({ pid: 1_000 + i, kind: 'agent', ticketId: null, label: 'x' });
    }
    await monitor.refreshNow();
    expect(readSnapshot).toHaveBeenCalledTimes(1);
  });

  it('spends ZERO liveCwd probes over 10 consecutive fast-lane ticks', async () => {
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
    monitor.setPanelVisible(true);
    for (let i = 0; i < 10; i += 1) await vi.advanceTimersByTimeAsync(FAST_LANE_INTERVAL_MS);
    expect(facts.liveCwd).not.toHaveBeenCalled();
    monitor.dispose();
  });

  it('never drives the disk lane from either interval — only an explicit measure', async () => {
    const monitor = new ResourceMonitor(makeDeps({}));
    monitor.start();
    monitor.setPanelVisible(true);

    const disk = { measureAll: vi.fn(async () => {}) } as unknown as WorktreeDiskCache;
    const posts: unknown[] = [];
    let receiveHandler: ((m: unknown) => void) | undefined;
    const panel = {
      reveal: vi.fn(),
      postMessage: vi.fn((m: unknown) => {
        posts.push(m);
      }),
      onDidReceiveMessage: vi.fn((h: (m: unknown) => void) => {
        receiveHandler = h;
      }),
      onDidDispose: vi.fn(),
    } as unknown as ResourcesPanel;
    const manager = new ResourcesPanelManager(
      { createPanel: () => panel },
      { monitor, disk, worktreePaths: () => ['/a'] },
    );
    manager.open();

    // Both lanes over several ticks: the disk lane is a PANEL concern and must
    // never be driven by the monitor's intervals.
    for (let i = 0; i < 3; i += 1) await vi.advanceTimersByTimeAsync(SLOW_LANE_INTERVAL_MS);
    for (let i = 0; i < 5; i += 1) await vi.advanceTimersByTimeAsync(FAST_LANE_INTERVAL_MS);
    expect(disk.measureAll).not.toHaveBeenCalled();

    // Only an explicit measure intent starts a pass.
    receiveHandler?.({ type: 'measure-disk', requestId: 'k1-abc' });
    await Promise.resolve();
    await Promise.resolve();
    expect(disk.measureAll).toHaveBeenCalledTimes(1);

    manager.dispose();
  });
});
