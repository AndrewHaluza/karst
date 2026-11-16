/**
 * The ONE Cancel operation for a graph run (T1133).
 *
 * A run in any non-terminal status (`planning`,
 * `running`, `draining`, `blocked`, `completed-awaiting-impl-marker`) can be
 * closed as `cancelled`. Order matters:
 *
 *  1. read the durable process facts of every live planner and node run
 *     (`process_runs` pid + start time), not this window's transport registry;
 *  2. attribute each pid. A `foreign` or `unknown` pid is a REFUSAL: nothing
 *     is signalled and no row changes, so the run is never claimed cancelled
 *     while a process we cannot prove ours may still hold its terminal;
 *  3. kill each attributable process tree (a `denied` kill is also a refusal);
 *  4. one `BEGIN IMMEDIATE` transaction writes every row (`store/graph`).
 *
 * Host-agnostic: db, process facts, kill, transaction and clock are injected.
 */

import type { GraphDb } from '../../store/graph/transitions.js';
import { graphRunStatus } from '../../store/graph/graphRuns.js';
import {
  CANCEL_TERMINAL_GRAPH_STATUSES,
  cancelGraphRunRows,
  cancelableProcesses,
  type CancelCounts,
} from '../../store/graph/cancelRun.js';
import { attributeOf } from './coordinator/reconcile.js';
import type { ProcessFactsSource } from '../../runtime/serverIdentity.js';
import type { KillOutcome } from '../../runtime/processTree.js';

export interface CancelGraphRunDeps {
  db: GraphDb;
  /** BEGIN IMMEDIATE-wrapped, all-or-nothing. */
  transaction: <T>(fn: () => T) => T;
  facts: ProcessFactsSource;
  killTree: (pid: number) => KillOutcome;
  now?: () => string;
  debug?: (message: string) => void;
}

export interface CancelRefusal {
  kind: 'planner' | 'node';
  runId: number;
  pid: number;
  reason: 'foreign' | 'unknown' | 'kill-denied';
}

export type CancelGraphRunResult =
  | { outcome: 'cancelled'; graphRunId: number; killed: number; counts: CancelCounts }
  | { outcome: 'refused-live-process'; graphRunId: number; killed: number; refusals: CancelRefusal[] }
  | { outcome: 'already-terminal'; graphRunId: number; status: string | undefined }
  | { outcome: 'raced'; graphRunId: number; killed: number };

export async function cancelGraphRun(
  deps: CancelGraphRunDeps,
  graphRunId: number,
  reason: string,
): Promise<CancelGraphRunResult> {
  const status = graphRunStatus(deps.db, graphRunId);
  if (status === undefined || CANCEL_TERMINAL_GRAPH_STATUSES.has(status)) {
    return { outcome: 'already-terminal', graphRunId, status };
  }

  const processes = cancelableProcesses(deps.db, graphRunId);
  const refusals: CancelRefusal[] = [];
  const toKill = new Map<number, { kind: 'planner' | 'node'; runId: number }>();
  for (const proc of processes) {
    const attribution = await attributeOf(deps.facts, proc);
    if (attribution === 'dead') continue;
    if (attribution === 'attributable') {
      if (!toKill.has(proc.pid)) toKill.set(proc.pid, { kind: proc.kind, runId: proc.runId });
      continue;
    }
    refusals.push({ kind: proc.kind, runId: proc.runId, pid: proc.pid, reason: attribution });
  }
  // A refusal acts BEFORE any signal: a partial kill would leave a half-dead run.
  if (refusals.length > 0) {
    deps.debug?.(`[graph] cancel: run ${graphRunId} refused — ${refusals.length} unattributable live pid(s)`);
    return { outcome: 'refused-live-process', graphRunId, killed: 0, refusals };
  }

  let killed = 0;
  for (const [pid, owner] of toKill) {
    if (deps.killTree(pid) === 'killed') {
      killed += 1;
    } else {
      refusals.push({ ...owner, pid, reason: 'kill-denied' });
    }
  }
  if (refusals.length > 0) {
    return { outcome: 'refused-live-process', graphRunId, killed, refusals };
  }

  const now = (deps.now ?? (() => new Date().toISOString()))();
  const counts = deps.transaction(() => cancelGraphRunRows(deps.db, graphRunId, status, reason, now));
  if (counts === null) {
    deps.debug?.(`[graph] cancel: run ${graphRunId} left ${status} under us — raced`);
    return { outcome: 'raced', graphRunId, killed };
  }
  return { outcome: 'cancelled', graphRunId, killed, counts };
}
