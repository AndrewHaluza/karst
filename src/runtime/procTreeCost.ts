import type { ProcRecord, ProcSnapshot } from './procSnapshot.js';
import { getCpuCoreCount } from './cpuCores.js';

/**
 * Per-leader process-tree cost, rolled up from a single snapshot's own ppid
 * index. A `npm run dev` leader's real cost lives in its descendants (Vite,
 * the build tool), so the leader's tree — not the leader alone — is what any
 * attribution must sum.
 *
 * CPU% is derived from the DELTA of cumulative CPU seconds between two
 * snapshots, never read from `ps %cpu`. The FIRST snapshot has no predecessor,
 * so `cpuPct` is `null` — "not measured yet", NEVER coerced to 0, which would
 * read as a measured idle tree.
 */
export interface TreeCost {
  /** The leader pid the cost is attributed to. */
  pid: number;
  /** Summed RSS of the leader and every descendant, in bytes. */
  rssBytes: number;
  /**
   * Instantaneous CPU across the tree, percent of one core (may exceed 100 for
   * a multi-threaded tree). NULL when no previous snapshot covers this tree —
   * "not measured yet", never 0.
   */
  cpuPct: number | null;
  /** Number of processes in the tree, including the leader. */
  procCount: number;
  /** Leader's start time, epoch ms, or null. */
  startedMs: number | null;
}

/**
 * Breadth-first walk of a process tree, leader included. A pid already visited
 * is not revisited (guards a malformed cyclic ppid table). Returns `[]` when
 * the leader is absent from the snapshot.
 */
export function collectTree(snapshot: ProcSnapshot, leader: number): ProcRecord[] {
  if (!snapshot.records.has(leader)) return [];
  const visited = new Set<number>();
  const queue: number[] = [leader];
  const result: ProcRecord[] = [];
  let head = 0;
  while (head < queue.length) {
    const pid = queue[head]!;
    head += 1;
    if (visited.has(pid)) continue;
    visited.add(pid);
    const record = snapshot.records.get(pid);
    if (!record) continue;
    result.push(record);
    for (const child of snapshot.children.get(pid) ?? []) {
      if (!visited.has(child)) queue.push(child);
    }
  }
  return result;
}

/**
 * Cost of one leader's tree, with an instantaneous CPU% derived from the
 * cumulative CPU-seconds delta between `snapshot` and `previous`.
 *
 * Returns `null` when the leader is gone (its tree is empty).
 *
 * The CPU delta is computed over the CURRENT tree members that ALSO exist in
 * `previous.records` **with the same `startedMs`** — a pid whose start time
 * changed is a different process, and its cumulative counter must never be
 * differenced against another process's. A negative result (counters went
 * backwards because processes left the tree) is clamped to 0.
 *
 * @param cpuCoreCount — Number of logical CPU cores. Defaults to `getCpuCoreCount()`.
 *   CPU% is normalized by this value (percent of total capacity, not one core).
 */
export function treeCost(
  snapshot: ProcSnapshot,
  previous: ProcSnapshot | null,
  leader: number,
  cpuCoreCount?: number,
): TreeCost | null {
  const tree = collectTree(snapshot, leader);
  if (tree.length === 0) return null;
  const rssBytes = tree.reduce((sum, record) => sum + record.rssBytes, 0);

  let cpuPct: number | null = null;
  if (previous !== null) {
    const wallDeltaMs = snapshot.takenMs - previous.takenMs;
    if (wallDeltaMs > 0 && tree.some((record) => previous.records.has(record.pid))) {
      let current = 0;
      let prior = 0;
      for (const record of tree) {
        const prev = previous.records.get(record.pid);
        if (prev !== undefined && prev.startedMs === record.startedMs) {
          current += record.cpuSeconds;
          prior += prev.cpuSeconds;
        }
      }
      const deltaSeconds = current - prior;
      const rawPct = Math.max(0, (deltaSeconds / (wallDeltaMs / 1000)) * 100);
      const cores = cpuCoreCount ?? getCpuCoreCount();
      const normalizedCores = Math.max(1, Math.floor(cores));
      cpuPct = Math.round(rawPct / normalizedCores);
    }
  }

  return {
    pid: leader,
    rssBytes,
    cpuPct,
    procCount: tree.length,
    startedMs: tree[0]!.startedMs,
  };
}

/**
 * Sum several tree costs. `cpuPct` is `null` only when EVERY input is `null`;
 * otherwise nulls contribute 0 (a tree that is not yet measured contributes
 * nothing rather than voiding the total).
 */
export function sumCosts(
  costs: readonly TreeCost[],
): { rssBytes: number; cpuPct: number | null } {
  const rssBytes = costs.reduce((sum, cost) => sum + cost.rssBytes, 0);
  const anyMeasured = costs.some((cost) => cost.cpuPct !== null);
  if (!anyMeasured) return { rssBytes, cpuPct: null };
  const cpuPct = costs.reduce((sum, cost) => sum + (cost.cpuPct ?? 0), 0);
  return { rssBytes, cpuPct };
}
