/**
 * Writes for the one graph-run Cancel operation (`approaches/graph/cancel.ts`).
 *
 * Every function here is driver-agnostic (`GraphDb`) and runs inside the
 * caller's `BEGIN IMMEDIATE` transaction. Status moves go through `casStatus`
 * and the transition maps, so a stale caller reads `false`, never corrupts.
 */

import type { GraphDb } from './transitions.js';
import {
  GRAPH_RUN_TRANSITIONS,
  NODE_RUN_TRANSITIONS,
  PLANNER_RUN_TRANSITIONS,
  casStatus,
} from './transitions.js';
import { transitionLease } from './leases.js';

/** Run statuses a cancel never changes: the run is already finished. */
export const CANCEL_TERMINAL_GRAPH_STATUSES: ReadonlySet<string> = new Set([
  'closed',
  'stale',
  'cancelled',
]);

/** A planner or node run with a recorded process, judged for liveness. */
export interface CancelableProcess {
  kind: 'planner' | 'node';
  runId: number;
  pid: number;
  startedAt: string | null;
}

export interface CancelCounts {
  plannerRuns: number;
  nodeRuns: number;
  leases: number;
  processRuns: number;
}

const NON_TERMINAL_PLANNER = `status NOT IN ('submitted','stale','cancelled')`;
const NON_TERMINAL_NODE = `status NOT IN ('completed','stale','cancelled')`;

/**
 * Every non-terminal planner and node run of the graph run that carries a
 * recorded pid. The `process_runs` status is NOT filtered: karst closes a row
 * as `interrupted` while the process may still live (T1107).
 */
export function cancelableProcesses(db: GraphDb, graphRunId: number): CancelableProcess[] {
  const planners = db
    .prepare(
      `SELECT r.id AS runId, p.pid AS pid, p.started_at AS startedAt
       FROM approach_planner_runs r JOIN process_runs p ON p.id = r.process_run_id
       WHERE r.graph_run_id = ? AND r.${NON_TERMINAL_PLANNER} AND p.pid IS NOT NULL
       ORDER BY r.id`,
    )
    .all(graphRunId) as Array<Omit<CancelableProcess, 'kind'>>;
  const nodes = db
    .prepare(
      `SELECT r.id AS runId, p.pid AS pid, p.started_at AS startedAt
       FROM approach_node_runs r JOIN process_runs p ON p.id = r.process_run_id
       WHERE r.graph_run_id = ? AND r.${NON_TERMINAL_NODE} AND p.pid IS NOT NULL
       ORDER BY r.id`,
    )
    .all(graphRunId) as Array<Omit<CancelableProcess, 'kind'>>;
  return [
    ...planners.map((row) => ({ ...row, kind: 'planner' as const })),
    ...nodes.map((row) => ({ ...row, kind: 'node' as const })),
  ];
}

/**
 * The cancel transaction body. The graph run moves first: when its CAS loses
 * (another window moved the run) nothing else is written and `null` returns.
 */
export function cancelGraphRunRows(
  db: GraphDb,
  graphRunId: number,
  fromStatus: string,
  reason: string,
  now: string,
): CancelCounts | null {
  if (!casStatus(db, 'approach_graph_runs', GRAPH_RUN_TRANSITIONS, graphRunId, fromStatus, 'cancelled')) {
    return null;
  }
  db.prepare(
    `UPDATE approach_graph_runs SET blocked_reason = ?, updated_at = ?, completed_at = COALESCE(completed_at, ?),
       active_processes = 0 WHERE id = ?`,
  ).run(reason, now, now, graphRunId);

  const processRunIds = new Set<number>();
  const cancelRuns = (table: string, map: Record<string, readonly string[]>, where: string): number => {
    const rows = db
      .prepare(`SELECT id, status, process_run_id AS processRunId FROM ${table} WHERE graph_run_id = ? AND ${where}`)
      .all(graphRunId) as Array<{ id: number; status: string; processRunId: number | null }>;
    let moved = 0;
    for (const row of rows) {
      if (!casStatus(db, table, map, row.id, row.status, 'cancelled')) continue;
      db.prepare(`UPDATE ${table} SET reason = ?, ended_at = COALESCE(ended_at, ?) WHERE id = ?`).run(
        reason,
        now,
        row.id,
      );
      if (row.processRunId !== null) processRunIds.add(row.processRunId);
      moved += 1;
    }
    return moved;
  };
  const plannerRuns = cancelRuns('approach_planner_runs', PLANNER_RUN_TRANSITIONS, NON_TERMINAL_PLANNER);
  const nodeRuns = cancelRuns('approach_node_runs', NODE_RUN_TRANSITIONS, NON_TERMINAL_NODE);

  const held = db
    .prepare(`SELECT id FROM approach_resource_leases WHERE graph_run_id = ? AND status = 'held'`)
    .all(graphRunId) as Array<{ id: number }>;
  let leases = 0;
  for (const lease of held) {
    if (!transitionLease(db, lease.id, 'held', 'released')) continue;
    db.prepare('UPDATE approach_resource_leases SET released_at = ? WHERE id = ?').run(now, lease.id);
    leases += 1;
  }

  let processRuns = 0;
  for (const id of processRunIds) {
    processRuns += db
      .prepare(`UPDATE process_runs SET status = 'interrupted', ended_at = ? WHERE id = ? AND status = 'running'`)
      .run(now, id).changes;
  }
  return { plannerRuns, nodeRuns, leases, processRuns };
}
