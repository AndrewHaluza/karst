import { describe, expect, it } from 'vitest';
import type { ProcRecord, ProcSnapshot } from './procSnapshot.js';
import { collectTree, sumCosts, treeCost } from './procTreeCost.js';

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

describe('collectTree', () => {
  it('returns [] when the leader is absent', () => {
    const s = snap(0, [record(1, 0, 10, 1, 1)]);
    expect(collectTree(s, 999)).toEqual([]);
  });

  it('walks leader plus all descendants breadth-first', () => {
    const s = snap(0, [
      record(100, 0, 10, 1, 1),
      record(101, 100, 20, 2, 1),
      record(102, 100, 30, 3, 1),
      record(103, 101, 40, 4, 1),
    ]);
    const pids = collectTree(s, 100).map((r) => r.pid);
    expect(pids).toEqual([100, 101, 102, 103]);
  });

  it('terminates on a cyclic ppid table', () => {
    const s = snap(0, [record(10, 11, 10, 1, 1), record(11, 10, 20, 2, 1)]);
    const tree = collectTree(s, 10);
    expect(tree.map((r) => r.pid).sort()).toEqual([10, 11]);
    expect(tree.length).toBe(2);
  });
});

describe('treeCost', () => {
  it('sums the RSS of a leader and its two children', () => {
    const s = snap(1_000, [
      record(100, 0, 10, 1, 1),
      record(101, 100, 20, 2, 1),
      record(102, 100, 30, 3, 1),
    ]);
    const cost = treeCost(s, null, 100);
    expect(cost?.rssBytes).toBe(60);
    expect(cost?.procCount).toBe(3);
  });

  it('has cpuPct null on the first snapshot (no previous) — never 0', () => {
    const s = snap(1_000, [record(100, 0, 10, 1, 1)]);
    const cost = treeCost(s, null, 100);
    expect(cost?.cpuPct).toBeNull();
  });

  it('yields 50 for 0.5 CPU-seconds over a 1 s wall gap', () => {
    const first = snap(1_000, [record(100, 0, 10, 10, 1)]);
    const second = snap(2_000, [record(100, 0, 10, 10.5, 1)]);
    expect(treeCost(second, first, 100)?.cpuPct).toBe(50);
  });

  it('yields 200 for 2.0 CPU-seconds across a 4-process tree over 1 s', () => {
    const first = snap(1_000, [
      record(100, 0, 10, 10, 1),
      record(101, 100, 10, 5, 1),
      record(102, 100, 10, 5, 1),
      record(103, 101, 10, 5, 1),
    ]);
    const second = snap(2_000, [
      record(100, 0, 10, 10.5, 1),
      record(101, 100, 10, 5.5, 1),
      record(102, 100, 10, 5.5, 1),
      record(103, 101, 10, 5.5, 1),
    ]);
    expect(treeCost(second, first, 100)?.cpuPct).toBe(200);
  });

  it('excludes a pid whose startedMs differs (a different process)', () => {
    const first = snap(1_000, [
      record(100, 0, 10, 10, 1),
      record(101, 100, 10, 5, 5_000),
    ]);
    const second = snap(2_000, [
      record(100, 0, 10, 12, 1),
      record(101, 100, 10, 6, 9_999),
    ]);
    const cost = treeCost(second, first, 100);
    expect(cost?.cpuPct).toBe(200);
    expect(cost?.rssBytes).toBe(20);
  });

  it('clamps a backwards counter to 0', () => {
    const first = snap(1_000, [record(100, 0, 10, 10, 1)]);
    const second = snap(2_000, [record(100, 0, 10, 8, 1)]);
    expect(treeCost(second, first, 100)?.cpuPct).toBe(0);
  });

  it('returns null for a missing leader', () => {
    const first = snap(1_000, [record(100, 0, 10, 10, 1)]);
    const second = snap(2_000, []);
    expect(treeCost(second, first, 100)).toBeNull();
  });

  it('returns cpuPct null for a zero wall delta', () => {
    const first = snap(1_000, [record(100, 0, 10, 10, 1)]);
    const second = snap(1_000, [record(100, 0, 10, 12, 1)]);
    expect(treeCost(second, first, 100)?.cpuPct).toBeNull();
  });

  it('includes RSS of a descendant that appeared since the previous snapshot but not its CPU delta', () => {
    const first = snap(1_000, [record(100, 0, 10, 10, 1)]);
    const second = snap(2_000, [
      record(100, 0, 10, 12, 1),
      record(101, 100, 40, 9, 7_000),
    ]);
    const cost = treeCost(second, first, 100);
    expect(cost?.rssBytes).toBe(50);
    expect(cost?.cpuPct).toBe(200);
  });
});

describe('sumCosts', () => {
  it('returns cpuPct null only when every input is null', () => {
    const nullCosts = [
      { pid: 1, rssBytes: 10, cpuPct: null as number | null, procCount: 1, startedMs: null },
      { pid: 2, rssBytes: 20, cpuPct: null as number | null, procCount: 1, startedMs: null },
    ];
    expect(sumCosts(nullCosts)).toEqual({ rssBytes: 30, cpuPct: null });
  });

  it('treats a null as 0 when any input is measured', () => {
    const costs = [
      { pid: 1, rssBytes: 10, cpuPct: null as number | null, procCount: 1, startedMs: null },
      { pid: 2, rssBytes: 20, cpuPct: 50 as number | null, procCount: 1, startedMs: null },
    ];
    expect(sumCosts(costs)).toEqual({ rssBytes: 30, cpuPct: 50 });
  });
});
