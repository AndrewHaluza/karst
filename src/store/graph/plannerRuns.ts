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

/* ------------------------------------------------------------------ */
/* Read helpers — named, narrowed reads (NDL-60). Every raw read of    */
/* `approach_planner_runs` lives here so a schema change is one module. */
/* ------------------------------------------------------------------ */

/** A planner run's status, or undefined when the row is gone. */
export function plannerRunStatus(db: GraphDb, id: number): string | undefined {
  const row = db
    .prepare('SELECT status FROM approach_planner_runs WHERE id = ?')
    .get(id) as { status: string } | undefined;
  return row?.status;
}

/** The compile attempts consumed so far (0 when the row is gone). */
export function plannerRunCompileAttempt(db: GraphDb, id: number): number {
  const row = db
    .prepare('SELECT compile_attempt FROM approach_planner_runs WHERE id = ?')
    .get(id) as { compile_attempt: number } | undefined;
  return row?.compile_attempt ?? 0;
}

/** The graph run a planner run belongs to, or undefined. */
export function plannerRunGraphRunId(db: GraphDb, id: number): number | undefined {
  const row = db
    .prepare('SELECT graph_run_id FROM approach_planner_runs WHERE id = ?')
    .get(id) as { graph_run_id: number } | undefined;
  return row?.graph_run_id;
}

/** The submission shape: the owning graph run, status and accepted snapshot. */
export function plannerRunSubmissionRef(
  db: GraphDb,
  id: number,
): Pick<PlannerRunRow, 'graph_run_id' | 'status' | 'graph_snapshot_id'> | undefined {
  return db
    .prepare('SELECT graph_run_id, status, graph_snapshot_id FROM approach_planner_runs WHERE id = ?')
    .get(id) as
    | Pick<PlannerRunRow, 'graph_run_id' | 'status' | 'graph_snapshot_id'>
    | undefined;
}

/** The snapshot/election shape: a planner run's id, status and snapshot. */
export function plannerRunSnapshotRef(
  db: GraphDb,
  id: number,
): Pick<PlannerRunRow, 'id' | 'status' | 'graph_snapshot_id'> | undefined {
  return db
    .prepare('SELECT id, status, graph_snapshot_id FROM approach_planner_runs WHERE id = ?')
    .get(id) as Pick<PlannerRunRow, 'id' | 'status' | 'graph_snapshot_id'> | undefined;
}

/** The oldest submitted planner run of a graph run and kind, or undefined. */
export function submittedPlannerRunForGraphRun(
  db: GraphDb,
  graphRunId: number,
  kind: 'bootstrap' | 'replan',
): Pick<PlannerRunRow, 'id' | 'status' | 'graph_snapshot_id'> | undefined {
  return db
    .prepare(
      `SELECT id, status, graph_snapshot_id FROM approach_planner_runs
       WHERE graph_run_id = ? AND kind = ? AND status = 'submitted'
       ORDER BY id LIMIT 1`,
    )
    .get(graphRunId, kind) as Pick<PlannerRunRow, 'id' | 'status' | 'graph_snapshot_id'> | undefined;
}

/** The newest planner run of a graph run and kind (launch-identity columns),
 *  or undefined. */
export function latestPlannerRunForGraphRunKind(
  db: GraphDb,
  graphRunId: number,
  kind: 'bootstrap' | 'replan',
): Pick<PlannerRunRow, 'id' | 'status' | 'owner_nonce' | 'process_run_id'> | undefined {
  return db
    .prepare(
      `SELECT id, status, owner_nonce, process_run_id FROM approach_planner_runs
       WHERE graph_run_id = ? AND kind = ? ORDER BY id DESC LIMIT 1`,
    )
    .get(graphRunId, kind) as
    | Pick<PlannerRunRow, 'id' | 'status' | 'owner_nonce' | 'process_run_id'>
    | undefined;
}

/** A graph run's planner runs in run-number order, narrowed to the Inside-view
 *  columns. */
export function plannerRunsForGraphRun(
  db: GraphDb,
  graphRunId: number,
): Array<
  Pick<
    PlannerRunRow,
    | 'planner_run_number'
    | 'kind'
    | 'status'
    | 'compile_attempt'
    | 'reason'
    | 'started_at'
    | 'submitted_at'
    | 'ended_at'
  >
> {
  return db
    .prepare(
      `SELECT planner_run_number, kind, status, compile_attempt, reason,
              started_at, submitted_at, ended_at
         FROM approach_planner_runs WHERE graph_run_id = ? ORDER BY planner_run_number`,
    )
    .all(graphRunId) as Array<
    Pick<
      PlannerRunRow,
      | 'planner_run_number'
      | 'kind'
      | 'status'
      | 'compile_attempt'
      | 'reason'
      | 'started_at'
      | 'submitted_at'
      | 'ended_at'
    >
  >;
}

/** Every planner run id of a graph run, newest first. */
export function plannerRunIdsForGraphRun(db: GraphDb, graphRunId: number): number[] {
  const rows = db
    .prepare('SELECT id FROM approach_planner_runs WHERE graph_run_id = ? ORDER BY id DESC')
    .all(graphRunId) as Array<{ id: number }>;
  return rows.map((r) => r.id);
}

/** The ticket a planner run's graph run belongs to, or undefined. */
export function plannerRunTicketId(db: GraphDb, id: number): number | undefined {
  const row = db
    .prepare(
      'SELECT ticket_id FROM approach_graph_runs gr JOIN approach_planner_runs p ON p.graph_run_id = gr.id WHERE p.id = ?',
    )
    .get(id) as { ticket_id: number } | undefined;
  return row?.ticket_id;
}

/** The per-run model identity a terminal (re)attach resolves. */
export function plannerRunModelIdentity(
  db: GraphDb,
  id: number,
): Pick<PlannerRunRow, 'id' | 'profile' | 'provider' | 'model'> | undefined {
  return db
    .prepare('SELECT id, profile, provider, model FROM approach_planner_runs WHERE id = ?')
    .get(id) as Pick<PlannerRunRow, 'id' | 'profile' | 'provider' | 'model'> | undefined;
}

/** The launch identity a reattach compares against a live session (planner runs). */
export function plannerRunSessionIdentity(
  db: GraphDb,
  id: number,
): Pick<PlannerRunRow, 'graph_run_id' | 'process_run_id' | 'generation' | 'owner_nonce' | 'started_at'> | undefined {
  return db
    .prepare(
      `SELECT graph_run_id, process_run_id, generation, owner_nonce, started_at
       FROM approach_planner_runs WHERE id = ?`,
    )
    .get(id) as
    | Pick<PlannerRunRow, 'graph_run_id' | 'process_run_id' | 'generation' | 'owner_nonce' | 'started_at'>
    | undefined;
}

/** True when a planner run of `graphRunId` exists OUTSIDE `terminalStatuses`. */
export function plannerRunExistsOutsideStatusesForGraphRun(
  db: GraphDb,
  id: number,
  graphRunId: number,
  terminalStatuses: readonly string[],
): boolean {
  const placeholders = terminalStatuses.map(() => '?').join(', ');
  const row = db
    .prepare(
      `SELECT 1 AS x FROM approach_planner_runs
       WHERE id = ? AND graph_run_id = ? AND status NOT IN (${placeholders}) LIMIT 1`,
    )
    .get(id, graphRunId, ...terminalStatuses);
  return row !== undefined;
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

/* ------------------------------------------------------------------ */
/* State writes — the ONLY place these columns are written (NDL-38).   */
/* ------------------------------------------------------------------ */

/** Record the content-addressed prompt hash and its artifact snapshot on a
 *  freshly allocated planner run (bootstrap and replan both). */
export function setPlannerRunPromptHashArtifact(
  db: GraphDb,
  id: number,
  promptHash: string,
  artifactSnapshotId: string,
): boolean {
  const res = db
    .prepare('UPDATE approach_planner_runs SET prompt_hash = ?, artifact_snapshot_id = ? WHERE id = ?')
    .run(promptHash, artifactSnapshotId, id);
  return res.changes === 1;
}

/** Record the submitted graph snapshot on a planner run (used at replan begin
 *  for the reasons file, and again on election). */
export function setPlannerRunGraphSnapshot(db: GraphDb, id: number, graphSnapshotId: string): boolean {
  const res = db
    .prepare('UPDATE approach_planner_runs SET graph_snapshot_id = ? WHERE id = ?')
    .run(graphSnapshotId, id);
  return res.changes === 1;
}

/** Mark a planner run `submitted`: the accepted graph snapshot and the
 *  submission time. */
export function setPlannerRunSubmittedSnapshot(
  db: GraphDb,
  id: number,
  graphSnapshotId: string,
  submittedAt: string,
): boolean {
  const res = db
    .prepare('UPDATE approach_planner_runs SET graph_snapshot_id = ?, submitted_at = ? WHERE id = ?')
    .run(graphSnapshotId, submittedAt, id);
  return res.changes === 1;
}

/** Stamp a planner run's end (`ended_at`). */
export function setPlannerRunEndedAt(db: GraphDb, id: number, now: string): boolean {
  const res = db.prepare('UPDATE approach_planner_runs SET ended_at = ? WHERE id = ?').run(now, id);
  return res.changes === 1;
}

/** Record the reason a planner run carries (deferral, rejection, late submit). */
export function setPlannerRunReason(db: GraphDb, id: number, reason: string): boolean {
  const res = db.prepare('UPDATE approach_planner_runs SET reason = ? WHERE id = ?').run(reason, id);
  return res.changes === 1;
}

/** Park a planner run: reason AND end in one write (compile-repair exhaustion
 *  and a rejected plan). */
export function setPlannerRunReasonEndedAt(
  db: GraphDb,
  id: number,
  reason: string,
  now: string,
): boolean {
  const res = db
    .prepare('UPDATE approach_planner_runs SET reason = ?, ended_at = ? WHERE id = ?')
    .run(reason, now, id);
  return res.changes === 1;
}

/** Record the compile attempt a rejection consumed. */
export function setPlannerRunCompileAttempt(db: GraphDb, id: number, attempt: number): boolean {
  const res = db
    .prepare('UPDATE approach_planner_runs SET compile_attempt = ? WHERE id = ?')
    .run(attempt, id);
  return res.changes === 1;
}

/** The launch identity a claim commits with the row. */
export function setPlannerRunLaunchIdentity(
  db: GraphDb,
  id: number,
  identity: { generation: string; capabilityHash: string; ownerNonce: string },
): boolean {
  const res = db
    .prepare(
      'UPDATE approach_planner_runs SET generation = ?, capability_hash = ?, owner_nonce = ? WHERE id = ?',
    )
    .run(identity.generation, identity.capabilityHash, identity.ownerNonce, id);
  return res.changes === 1;
}

/** Record the durable process run a launched planner run is bound to. */
export function setPlannerRunProcessRunId(db: GraphDb, id: number, processRunId: number): boolean {
  const res = db
    .prepare('UPDATE approach_planner_runs SET process_run_id = ? WHERE id = ?')
    .run(processRunId, id);
  return res.changes === 1;
}

/** Stamp `started_at` only when the planner run still has none: a re-prompted
 *  planner keeps the wall-clock its FIRST session began at. */
export function markPlannerRunStarted(db: GraphDb, id: number, now: string): boolean {
  const res = db
    .prepare('UPDATE approach_planner_runs SET started_at = ? WHERE id = ? AND started_at IS NULL')
    .run(now, id);
  return res.changes === 1;
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
