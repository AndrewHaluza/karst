/**
 * Planner-run store: one monotonic planner-run number per graph run. The
 * durable bootstrap `PlannerRun` lifecycle lives in the coordinator
 * (`approaches/graph/coordinator/plannerRun.ts`, Slice-2 T5); this module is
 * the store half.
 *
 * Initial planning and replanning share one planner-run protocol with
 * distinct immutable run identities: every new planner invocation (bootstrap
 * or replan) allocates the next monotonic number for its graph run.
 * Driver-agnostic by contract (positional `?` only) — the CLI opens the same
 * store with `node:sqlite`.
 */

import type { GraphDb } from './transitions.js';
import { PLANNER_RUN_TRANSITIONS, casStatus } from './transitions.js';

export interface CreatePlannerRun {
  graphRunId: number;
  plannerRunNumber: number;
  kind: 'bootstrap' | 'replan';
}

export interface PlannerRunRow {
  id: number;
  graph_run_id: number;
  target_revision_number: number | null;
  planner_run_number: number;
  kind: 'bootstrap' | 'replan';
  status: string;
  profile: string | null;
  provider: string | null;
  model: string | null;
  effort: string | null;
  prompt_hash: string | null;
  compile_attempt: number;
  launch_attempt: number;
  generation: string | null;
  process_run_id: number | null;
  owner_nonce: string | null;
  capability_hash: string | null;
  graph_snapshot_id: string | null;
  artifact_snapshot_id: string | null;
  reason: string | null;
  started_at: string | null;
  submitted_at: string | null;
  ended_at: string | null;
}

export function createPlannerRun(db: GraphDb, input: CreatePlannerRun): number {
  const res = db
    .prepare(
      `INSERT INTO approach_planner_runs (graph_run_id, planner_run_number, kind, status)
       VALUES (?, ?, ?, 'ready')`,
    )
    .run(input.graphRunId, input.plannerRunNumber, input.kind);
  return Number(res.lastInsertRowid);
}

export function plannerRunById(db: GraphDb, id: number): PlannerRunRow | undefined {
  return db
    .prepare('SELECT * FROM approach_planner_runs WHERE id = ?')
    .get(id) as PlannerRunRow | undefined;
}

/** The next monotonic planner-run number for a graph run (1-based). */
export function nextPlannerRunNumber(db: GraphDb, graphRunId: number): number {
  const row = db
    .prepare(
      'SELECT COALESCE(MAX(planner_run_number), 0) + 1 AS next FROM approach_planner_runs WHERE graph_run_id = ?',
    )
    .get(graphRunId) as { next: number };
  return row.next;
}

/**
 * Compare-and-set a planner-run transition. Returns false when the row
 * already moved; throws for a pair absent from the map.
 */
export function transitionPlannerRun(db: GraphDb, id: number, from: string, to: string): boolean {
  return casStatus(db, 'approach_planner_runs', PLANNER_RUN_TRANSITIONS, id, from, to);
}

/**
 * The planner-run statuses that still owe their graph run a submission — a
 * planner in one of these is working, waiting to be launched, or waiting to be
 * re-prompted, and something will still move it.
 *
 * ONE definition, because three call sites ask the same question about a
 * `draining` run and must never disagree: the Inside projection decides
 * whether to mint the H2 Restart control, the action dispatch re-checks it
 * before routing the click, and `restartStoppedGraph` re-checks it again
 * inside the coordinator. A status added to `PLANNER_RUN_TRANSITIONS` is
 * added here once, or those three drift into disagreeing about whether a
 * Restart is legal.
 */
export const LIVE_PLANNER_STATUSES = [
  'ready',
  'launching',
  'running',
  'submitted',
  'blocked',
] as const;

/**
 * Whether a replan planner still owes this graph run a submission. `draining`
 * is entered for two unrelated reasons — a replan planner is compiling
 * revision N+1, or Stop halted the run — and this is what tells them apart:
 * true means the coordinator owns the run's exit, false means the run was
 * stopped and only a deliberate Restart (H2) will move it.
 */
export function hasLiveReplanPlanner(db: GraphDb, graphRunId: number): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS live FROM approach_planner_runs
       WHERE graph_run_id = ? AND kind = 'replan'
         AND status IN (${LIVE_PLANNER_STATUSES.map(() => '?').join(',')})
       LIMIT 1`,
    )
    .get(graphRunId, ...LIVE_PLANNER_STATUSES) as { live: number } | undefined;
  return row !== undefined;
}
