import { describe, expect, it, vi } from 'vitest';
import type { ProcRecord, ProcSnapshot } from './procSnapshot.js';
import type { ProcessFactsSource } from './serverIdentity.js';
import {
  buildInventory,
  HEAVY_RSS_BYTES,
  MAX_CWD_PROBES_PER_TICK,
  UNATTRIBUTED_TOP_N,
  type KnownPid,
} from './resourceInventory.js';

function record(
  pid: number,
  ppid: number,
  rssBytes: number,
  cpuSeconds: number,
  startedMs: number | null,
): ProcRecord {
  return { pid, ppid, rssBytes, cpuSeconds, startedMs, comm: `p${pid}` };
}

function snap(takenMs: number, recs: ProcRecord[]): ProcSnapshot {
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

function serverEntry(pid: number, opts: Partial<KnownPid> = {}): KnownPid {
  return {
    pid,
    kind: 'server',
    ticketId: 7,
    label: 'web',
    identity: { pid, cwd: '/wt/x', startedAt: '2026-08-12T10:00:00.000Z' },
    serverId: 1,
    ...opts,
  };
}

function facts(): ProcessFactsSource & { liveCwd: ReturnType<typeof vi.fn> } {
  return {
    isAlive: vi.fn(() => true),
    liveCwd: vi.fn(() => ({ path: '/wt/x', deleted: false })),
    processStartMs: vi.fn(() => 1_000),
  };
}

describe('buildInventory', () => {
  it('rolls up an attributed server tree RSS', async () => {
    const s = snap(1_000, [
      record(100, 0, 10, 1, 1),
      record(101, 100, 20, 2, 1),
      record(102, 100, 30, 3, 1),
    ]);
    const inv = await buildInventory({
      snapshot: s,
      previous: null,
      known: [serverEntry(100)],
      facts: facts(),
      confirmCwd: false,
    });
    expect(inv.attributed).toHaveLength(1);
    expect(inv.attributed[0]!.attribution).toBe('attributable');
    expect(inv.attributed[0]!.cost?.rssBytes).toBe(60);
    expect(inv.attributed[0]!.cost?.procCount).toBe(3);
    expect(inv.totals.rssBytes).toBe(60);
  });

  it('never lists a child of a known server as unattributed', async () => {
    const s = snap(1_000, [
      record(100, 0, 10, 1, 1),
      record(101, 100, 20, 2, 1),
      record(200, 0, 5, 1, 1),
    ]);
    const inv = await buildInventory({
      snapshot: s,
      previous: null,
      known: [serverEntry(100)],
      facts: facts(),
      confirmCwd: false,
    });
    const pids = inv.unattributed.map((r) => r.pid);
    expect(pids).toEqual([200]);
    expect(pids).not.toContain(100);
    expect(pids).not.toContain(101);
  });

  it('caps the unattributed lane at 5 and sorts by RSS descending', async () => {
    const recs = [300, 301, 302, 303, 304, 305, 306].map((pid, i) =>
      record(pid, 0, 700 - i * 100, 1, 1),
    );
    const s = snap(1_000, recs);
    const inv = await buildInventory({
      snapshot: s,
      previous: null,
      known: [],
      facts: facts(),
      confirmCwd: false,
    });
    expect(inv.unattributed).toHaveLength(UNATTRIBUTED_TOP_N);
    const rss = inv.unattributed.map((r) => r.cost.rssBytes);
    expect([...rss]).toEqual([...rss].sort((a, b) => b - a));
    expect(rss[0]).toBe(700);
    expect(rss[4]).toBe(300);
  });

  it('spends ZERO liveCwd probes when confirmCwd is false', async () => {
    const heavy = record(400, 0, HEAVY_RSS_BYTES + 1, 1, 1);
    const s = snap(1_000, [heavy]);
    const f = facts();
    const inv = await buildInventory({
      snapshot: s,
      previous: null,
      known: [],
      facts: f,
      confirmCwd: false,
    });
    expect(inv.unattributed[0]!.cwd).toBeNull();
    expect(f.liveCwd).not.toHaveBeenCalled();
  });

  it('spends at most MAX_CWD_PROBES_PER_TICK and only on rows over the thresholds', async () => {
    const s = snap(2_000, [
      record(401, 0, HEAVY_RSS_BYTES + 30, 1, 1),
      record(402, 0, HEAVY_RSS_BYTES + 20, 1, 1),
      record(403, 0, HEAVY_RSS_BYTES + 10, 1, 1),
      record(404, 0, 1_000_000, 1, 1),
    ]);
    const f = facts();
    const inv = await buildInventory({
      snapshot: s,
      previous: null,
      known: [],
      facts: f,
      confirmCwd: true,
    });
    expect(f.liveCwd).toHaveBeenCalledTimes(MAX_CWD_PROBES_PER_TICK);
    const probed = f.liveCwd.mock.calls.map(([pid]) => pid as number);
    expect(probed).toEqual([401, 402, 403]);
    expect(probed).not.toContain(404);
    expect(inv.unattributed.find((r) => r.pid === 401)?.cwd).toBe('/wt/x');
    expect(inv.unattributed.find((r) => r.pid === 404)?.cwd).toBeNull();
  });

  it('probes a heavy-by-CPU row and skips a light row while budget remains', async () => {
    const first = snap(1_000, [record(501, 0, 1_000_000, 10, 1), record(502, 0, 1_000_000, 10, 1)]);
    const s = snap(2_000, [
      record(501, 0, 1_000_000, 10, 1),
      record(502, 0, 1_000_000, 10.5, 1),
    ]);
    const f = facts();
    await buildInventory({ snapshot: s, previous: first, known: [], facts: f, confirmCwd: true });
    const probed = f.liveCwd.mock.calls.map(([pid]) => pid as number);
    expect(probed).toEqual([502]);
  });

  it('counts a duplicate known pid once', async () => {
    const s = snap(1_000, [
      record(100, 0, 10, 1, 1),
      record(101, 100, 20, 2, 1),
    ]);
    const inv = await buildInventory({
      snapshot: s,
      previous: null,
      known: [
        serverEntry(100, { serverId: 1 }),
        serverEntry(100, { serverId: 2 }),
      ],
      facts: facts(),
      confirmCwd: false,
    });
    expect(inv.attributed).toHaveLength(1);
    expect(inv.attributed[0]!.serverId).toBe(1);
    expect(inv.totals.rssBytes).toBe(30);
  });

  it('yields cost null and dead attribution for a known pid missing from the snapshot', async () => {
    const s = snap(1_000, [record(100, 0, 10, 1, 1)]);
    const inv = await buildInventory({
      snapshot: s,
      previous: null,
      known: [{ pid: 999, kind: 'agent', ticketId: null, label: 'impl' }],
      facts: facts(),
      confirmCwd: false,
    });
    expect(inv.attributed[0]!.cost).toBeNull();
    expect(inv.attributed[0]!.attribution).toBe('dead');
  });

  it('yields totals.cpuPct null when previous is null', async () => {
    const s = snap(1_000, [record(100, 0, 10, 1, 1)]);
    const inv = await buildInventory({
      snapshot: s,
      previous: null,
      known: [serverEntry(100)],
      facts: facts(),
      confirmCwd: false,
    });
    expect(inv.totals.cpuPct).toBeNull();
  });

  it('skips a non-positive known pid before any probe', async () => {
    const s = snap(1_000, [record(100, 0, 10, 1, 1)]);
    const f = facts();
    const inv = await buildInventory({
      snapshot: s,
      previous: null,
      known: [serverEntry(-1), serverEntry(0)],
      facts: f,
      confirmCwd: true,
    });
    expect(inv.attributed).toHaveLength(0);
    expect(f.isAlive).not.toHaveBeenCalled();
  });
});
