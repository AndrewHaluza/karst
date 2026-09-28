/**
 * Graph-run store: durable run creation per (ticket, stage attempt) and the
 * graph-run transition map, driven by the shared compare-and-set primitive.
 * Driver-agnostic (positional `?` only) — the CLI opens the same store.
 */

import type { GraphDb } from './transitions.js';
import { GRAPH_RUN_TRANSITIONS, casStatus } from './transitions.js';

/**
 * The canonical `approach_graph_runs` row shape — every column, so a call
 * site that only needs a subset narrows with `Pick<GraphRunRow, ...>` instead
 * of hand-declaring its own (drifting) interface (NDL-38).
 */
export interface GraphRunRow {
  id: number;
  ticket_id: number;
  stage_key: string;
  stage_attempt: number;
  approach_id: string;
  status: string;
  planner_run_count: number;
  expert_run_count: number;
  node_run_count: number;
  replan_count: number;
  blocked_reason: string | null;
  created_at: string;
  updated_at: string | null;
  completed_at: string | null;
  workspace_bytes: number;
  active_processes: number;
}

export interface CreateGraphRun {
  ticketId: number;
  stageAttempt: number;
  approachId: string;
  now: string;
}

export function createGraphRun(db: GraphDb, input: CreateGraphRun): number {
  const res = db
    .prepare(
      `INSERT INTO approach_graph_runs
        (ticket_id, stage_key, stage_attempt, approach_id, status, created_at)
       VALUES (?, 'impl', ?, ?, 'planning', ?)`,
    )
    .run(input.ticketId, input.stageAttempt, input.approachId, input.now);
  return Number(res.lastInsertRowid);
}

export function graphRunById(db: GraphDb, id: number): GraphRunRow | undefined {
  return db
    .prepare('SELECT * FROM approach_graph_runs WHERE id = ?')
    .get(id) as GraphRunRow | undefined;
}

/**
 * The 1-based ordinal of `runId` among the ticket's OWN graph runs — the ONE
 * definition of the number every surface displays. `approach_graph_runs.id` is
 * a registry-wide row id shared by every ticket in the project; printing it
 * anywhere a human reads makes two surfaces of the same run disagree (the
 * report: a stage block reading `graph run 5` beside a panel reading `run 1`).
 */
export function graphRunOrdinal(db: GraphDb, ticketId: number, runId: number): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM approach_graph_runs WHERE ticket_id = ? AND id <= ?')
    .get(ticketId, runId) as { n: number };
  return row.n;
}

/** The active graph run for a ticket/stage attempt, or undefined. */
export function graphRunForTicket(
  db: GraphDb,
  ticketId: number,
  stageAttempt: number,
): GraphRunRow | undefined {
  return db
    .prepare(
      'SELECT * FROM approach_graph_runs WHERE ticket_id = ? AND stage_attempt = ? ORDER BY id DESC LIMIT 1',
    )
    .get(ticketId, stageAttempt) as GraphRunRow | undefined;
}

/**
 * Compare-and-set a graph-run transition. Returns false when the row already
 * moved (a raced transition from another window) — never throws for a stale
 * caller, only for a pair absent from the transition map.
 */
export function transitionGraphRun(db: GraphDb, id: number, from: string, to: string): boolean {
  return casStatus(db, 'approach_graph_runs', GRAPH_RUN_TRANSITIONS, id, from, to);
}

/** True when every graph run of the ticket has status `closed` — the
 *  retention sweep's predicate (Slice 2 Task 8). */
export function allGraphRunsClosed(db: GraphDb, ticketId: number): boolean {
  const row = db
    .prepare(
      "SELECT 1 AS open FROM approach_graph_runs WHERE ticket_id = ? AND status != 'closed' LIMIT 1",
    )
    .get(ticketId) as { open: number } | undefined;
  return row === undefined;
}

/** Every graph run id of a ticket, in creation order (evidence deletion). */
export function graphRunIdsForTicket(db: GraphDb, ticketId: number): number[] {
  const rows = db
    .prepare('SELECT id FROM approach_graph_runs WHERE ticket_id = ?')
    .all(ticketId) as Array<{ id: number }>;
  return rows.map((r) => r.id);
}

/** Remove a graph run's planner/node run rows and the run itself (leaf-first). */
export function deleteGraphRunData(db: GraphDb, graphRunId: number): void {
  db.prepare('DELETE FROM approach_graph_tokens WHERE revision_id IN (SELECT id FROM approach_graph_revisions WHERE graph_run_id = ?)').run(graphRunId);
  db.prepare('DELETE FROM approach_node_overrides WHERE graph_run_id = ?').run(graphRunId);
  db.prepare('DELETE FROM approach_resource_leases WHERE graph_run_id = ?').run(graphRunId);
  db.prepare('DELETE FROM approach_node_deferrals WHERE graph_run_id = ?').run(graphRunId);
  db.prepare('DELETE FROM approach_artifact_instances WHERE graph_run_id = ?').run(graphRunId);
  db.prepare('DELETE FROM approach_graph_workspaces WHERE graph_run_id = ?').run(graphRunId);
  db.prepare('DELETE FROM approach_node_runs WHERE graph_run_id = ?').run(graphRunId);
  db.prepare('DELETE FROM approach_planner_runs WHERE graph_run_id = ?').run(graphRunId);
  db.prepare('DELETE FROM approach_graph_revisions WHERE graph_run_id = ?').run(graphRunId);
  db.prepare('DELETE FROM approach_graph_runs WHERE id = ?').run(graphRunId);
}

/* ------------------------------------------------------------------ */
/* State writes — the ONLY place these columns are written (NDL-38).   */
/* ------------------------------------------------------------------ */

/**
 * Record the reason a graph run is blocked and stamp `updated_at`. The
 * caller owns the status compare-and-set (`transitionGraphRun`); this write
 * only fills the reason on the row it just won, so a raced caller never
 * rewrites another window's block.
 */
export function markGraphRunBlocked(db: GraphDb, id: number, reason: string, now: string): boolean {
  const res = db
    .prepare('UPDATE approach_graph_runs SET blocked_reason = ?, updated_at = ? WHERE id = ?')
    .run(reason, now, id);
  return res.changes === 1;
}

/** Clear a graph run's blocked reason and stamp `updated_at` — the recovery
 *  exits that re-open a parked run. */
export function clearGraphRunBlocked(db: GraphDb, id: number, now: string): boolean {
  const res = db
    .prepare('UPDATE approach_graph_runs SET blocked_reason = NULL, updated_at = ? WHERE id = ?')
    .run(now, id);
  return res.changes === 1;
}

/** Stamp `updated_at` without changing status or reason — the "this run was
 *  observed and deliberately left alone" write. */
export function touchGraphRun(db: GraphDb, id: number, now: string): boolean {
  const res = db
    .prepare('UPDATE approach_graph_runs SET updated_at = ? WHERE id = ?')
    .run(now, id);
  return res.changes === 1;
}

/** Count one more accepted replan against the run's replan budget. */
export function incrementReplanCount(db: GraphDb, id: number, now: string): boolean {
  const res = db
    .prepare('UPDATE approach_graph_runs SET replan_count = replan_count + 1, updated_at = ? WHERE id = ?')
    .run(now, id);
  return res.changes === 1;
}

/** Count one more reserved node run (the claim's budget reservation). */
export function incrementNodeRunCount(db: GraphDb, id: number, now: string): boolean {
  const res = db
    .prepare(
      'UPDATE approach_graph_runs SET node_run_count = node_run_count + 1, updated_at = ? WHERE id = ?',
    )
    .run(now, id);
  return res.changes === 1;
}

/** Count one more reserved expert run (the claim's expert-budget reservation). */
export function incrementExpertRunCount(db: GraphDb, id: number, now: string): boolean {
  const res = db
    .prepare(
      'UPDATE approach_graph_runs SET expert_run_count = expert_run_count + 1, updated_at = ? WHERE id = ?',
    )
    .run(now, id);
  return res.changes === 1;
}

/** Release one reserved node run. Never goes below zero (`node_run_count > 0`
 *  is the write's own guard). */
export function decrementNodeRunCount(db: GraphDb, id: number, now: string): boolean {
  const res = db
    .prepare(
      'UPDATE approach_graph_runs SET node_run_count = node_run_count - 1, updated_at = ? WHERE id = ? AND node_run_count > 0',
    )
    .run(now, id);
  return res.changes === 1;
}

/** Release one reserved expert run. Never goes below zero. */
export function decrementExpertRunCount(db: GraphDb, id: number, now: string): boolean {
  const res = db
    .prepare(
      'UPDATE approach_graph_runs SET expert_run_count = expert_run_count - 1, updated_at = ? WHERE id = ? AND expert_run_count > 0',
    )
    .run(now, id);
  return res.changes === 1;
}

/** Stamp the run quiesced (`completed-awaiting-impl-marker`, Slice 2 Task 8). */
export function setGraphRunCompletedAt(db: GraphDb, id: number, now: string): boolean {
  const res = db
    .prepare('UPDATE approach_graph_runs SET completed_at = ? WHERE id = ?')
    .run(now, id);
  return res.changes === 1;
}

/** Release one process slot for a command node's deterministic completion —
 *  guarded to command runs (`active_processes` never below zero). */
export function releaseCommandProcessSlot(db: GraphDb, nodeRunId: number, now: string): boolean {
  const res = db
    .prepare(
      `UPDATE approach_graph_runs
       SET active_processes = MAX(active_processes - 1, 0), updated_at = ?
       WHERE id = (SELECT graph_run_id FROM approach_node_runs WHERE id = ?)
         AND (SELECT node_kind FROM approach_node_runs WHERE id = ?) = 'command'`,
    )
    .run(now, nodeRunId, nodeRunId);
  return res.changes === 1;
}

/** Release one process slot after a failed launch, stamping `updated_at`. */
export function releaseGraphProcessSlot(db: GraphDb, id: number, now: string): boolean {
  const res = db
    .prepare(
      'UPDATE approach_graph_runs SET active_processes = MAX(active_processes - 1, 0), updated_at = ? WHERE id = ?',
    )
    .run(now, id);
  return res.changes === 1;
}
