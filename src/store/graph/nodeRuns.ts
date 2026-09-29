/**
 * Node-run store: one visit per revision/node (a recovery retry reuses the
 * same reserved visit, incrementing only the launch-attempt counter), the
 * node-run transition map through the shared compare-and-set primitive, and
 * the per-node OVERRIDE surface (Slice 4 Task 6).
 *
 * An override is scoped to `(revision_id, node_id, kind)` — it applies to
 * every future unclaimed visit or retry of that node in that revision until
 * cleared, never mutates an active or frozen launch, and never carries into a
 * replanned revision N+1 (a different `revision_id` has no rows). The write's
 * compare-and-set gate is the NODE RUN status, not the override row: a node
 * is editable only while it has NO node run in a claimed/launched status
 * (its runs all sit in `ready`, `blocked`, or `failed-to-launch`); once
 * launch claiming has begun, the effective configuration is frozen and the
 * write fails. `row_version` remains for optimistic concurrency between
 * concurrent writers.
 */

import type { GraphDb } from './transitions.js';
import { NODE_RUN_TRANSITIONS, casStatus } from './transitions.js';

/**
 * The canonical `approach_node_runs` row shape — every column, so a call
 * site that only needs a subset narrows with `Pick<NodeRunRow, ...>` instead
 * of hand-declaring its own (drifting) interface (NDL-38).
 */
export interface NodeRunRow {
  id: number;
  graph_run_id: number;
  revision_id: number;
  node_id: string;
  node_kind: string;
  visit_number: number;
  status: string;
  outcome: string | null;
  effective_outcome: string | null;
  reason: string | null;
  failure_category: string | null;
  profile: string | null;
  provider: string | null;
  model: string | null;
  effort: string | null;
  prompt_hash: string | null;
  launch_attempt: number;
  generation: string | null;
  process_run_id: number | null;
  owner_nonce: string | null;
  capability_hash: string | null;
  instruction_artifact_id: number | null;
  input_artifact_id: number | null;
  output_artifact_id: number | null;
  change_set_id: string | null;
  started_at: string | null;
  ended_at: string | null;
  base_heads: string | null;
}

export function nodeRunById(db: GraphDb, id: number): NodeRunRow | undefined {
  return db.prepare('SELECT * FROM approach_node_runs WHERE id = ?').get(id) as
    | NodeRunRow
    | undefined;
}

/* ------------------------------------------------------------------ */
/* Read helpers — named, narrowed reads (NDL-60). Every raw read of    */
/* `approach_node_runs` lives here so a schema change is one module.    */
/* ------------------------------------------------------------------ */

/** A node run's status, or undefined when the row is gone. */
export function nodeRunStatus(db: GraphDb, id: number): string | undefined {
  const row = db
    .prepare('SELECT status FROM approach_node_runs WHERE id = ?')
    .get(id) as { status: string } | undefined;
  return row?.status;
}

/** The next visit number a node would allocate: MAX(visit_number) + 1. */
export function nextVisitNumber(db: GraphDb, revisionId: number, nodeId: string): number {
  const row = db
    .prepare(
      'SELECT COALESCE(MAX(visit_number), 0) + 1 AS next FROM approach_node_runs WHERE revision_id = ? AND node_id = ?',
    )
    .get(revisionId, nodeId) as { next: number };
  return row.next;
}

/** The newest node run id for (revision, node), or undefined. */
export function latestNodeRunIdForRevisionNode(
  db: GraphDb,
  revisionId: number,
  nodeId: string,
): number | undefined {
  const row = db
    .prepare(
      'SELECT id FROM approach_node_runs WHERE revision_id = ? AND node_id = ? ORDER BY id DESC LIMIT 1',
    )
    .get(revisionId, nodeId) as { id: number } | undefined;
  return row?.id;
}

/** Every node run id of a graph run, in id order. */
export function nodeRunIdsForGraphRun(db: GraphDb, graphRunId: number): number[] {
  const rows = db
    .prepare('SELECT id FROM approach_node_runs WHERE graph_run_id = ?')
    .all(graphRunId) as Array<{ id: number }>;
  return rows.map((r) => r.id);
}

/** The node run ids of a graph run in one of `statuses`, in id order. */
export function nodeRunIdsInStatusesForGraphRun(
  db: GraphDb,
  graphRunId: number,
  statuses: readonly string[],
): number[] {
  const placeholders = statuses.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT id FROM approach_node_runs
       WHERE graph_run_id = ? AND status IN (${placeholders})
       ORDER BY id`,
    )
    .all(graphRunId, ...statuses) as Array<{ id: number }>;
  return rows.map((r) => r.id);
}

/** The graph run a node run belongs to, or undefined. */
export function nodeRunGraphRunId(db: GraphDb, id: number): number | undefined {
  const row = db
    .prepare('SELECT graph_run_id FROM approach_node_runs WHERE id = ?')
    .get(id) as { graph_run_id: number } | undefined;
  return row?.graph_run_id;
}

/** The ticket a node run's graph run belongs to, or undefined. */
export function nodeRunTicketId(db: GraphDb, id: number): number | undefined {
  const row = db
    .prepare(
      'SELECT gr.ticket_id FROM approach_node_runs nr JOIN approach_graph_runs gr ON gr.id = nr.graph_run_id WHERE nr.id = ?',
    )
    .get(id) as { ticket_id: number } | undefined;
  return row?.ticket_id;
}

/** The per-run model identity a terminal (re)attach resolves. */
export function nodeRunModelIdentity(
  db: GraphDb,
  id: number,
): Pick<NodeRunRow, 'id' | 'profile' | 'provider' | 'model'> | undefined {
  return db
    .prepare('SELECT id, profile, provider, model FROM approach_node_runs WHERE id = ?')
    .get(id) as Pick<NodeRunRow, 'id' | 'profile' | 'provider' | 'model'> | undefined;
}

/** A graph run's node runs in id order, narrowed to the Inside-view columns. */
export function nodeRunsForGraphRunDisplay(
  db: GraphDb,
  graphRunId: number,
): Array<
  Pick<
    NodeRunRow,
    | 'id'
    | 'node_id'
    | 'node_kind'
    | 'revision_id'
    | 'visit_number'
    | 'status'
    | 'outcome'
    | 'reason'
    | 'provider'
    | 'model'
    | 'effort'
    | 'profile'
    | 'launch_attempt'
    | 'started_at'
    | 'ended_at'
  >
> {
  return db
    .prepare(
      `SELECT id, node_id, node_kind, revision_id, visit_number, status, outcome, reason,
              provider, model, effort, profile, launch_attempt, started_at, ended_at
         FROM approach_node_runs WHERE graph_run_id = ? ORDER BY id`,
    )
    .all(graphRunId) as Array<
    Pick<
      NodeRunRow,
      | 'id'
      | 'node_id'
      | 'node_kind'
      | 'revision_id'
      | 'visit_number'
      | 'status'
      | 'outcome'
      | 'reason'
      | 'provider'
      | 'model'
      | 'effort'
      | 'profile'
      | 'launch_attempt'
      | 'started_at'
      | 'ended_at'
    >
  >;
}

/** The graph run's node runs (launch-identity columns), in id order — the
 *  reconcile sweep's deterministic read. */
export function nodeRunsForGraphRun(
  db: GraphDb,
  graphRunId: number,
): Array<Pick<NodeRunRow, 'id' | 'status' | 'owner_nonce' | 'process_run_id'>> {
  return db
    .prepare(
      'SELECT id, status, owner_nonce, process_run_id FROM approach_node_runs WHERE graph_run_id = ? ORDER BY id',
    )
    .all(graphRunId) as Array<
    Pick<NodeRunRow, 'id' | 'status' | 'owner_nonce' | 'process_run_id'>
  >;
}

/** The `ready` (or identity-free re-armed `launching`) node runs a driver may
 *  execute, in id order. The second arm is only sound because the launch
 *  identity is committed with the `ready → launching` transition. */
export function runnableNodeRunsForGraphRun(
  db: GraphDb,
  graphRunId: number,
): Array<
  Pick<NodeRunRow, 'id' | 'revision_id' | 'node_id' | 'status' | 'owner_nonce' | 'process_run_id'>
> {
  return db
    .prepare(
      `SELECT id, revision_id, node_id, status, owner_nonce, process_run_id
       FROM approach_node_runs
       WHERE graph_run_id = ?
         AND (
           status = 'ready'
           OR (status = 'launching' AND owner_nonce IS NULL AND process_run_id IS NULL)
         )
       ORDER BY id`,
    )
    .all(graphRunId) as Array<
    Pick<NodeRunRow, 'id' | 'revision_id' | 'node_id' | 'status' | 'owner_nonce' | 'process_run_id'>
  >;
}

/** How many node runs (revision, node) has, regardless of status. */
export function countNodeRunsForRevisionNode(
  db: GraphDb,
  revisionId: number,
  nodeId: string,
): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM approach_node_runs WHERE revision_id = ? AND node_id = ?')
    .get(revisionId, nodeId) as { n: number };
  return row.n;
}

/** How many node runs (revision, node) ended with `outcome`. */
export function countNodeRunsForRevisionNodeByOutcome(
  db: GraphDb,
  revisionId: number,
  nodeId: string,
  outcome: string,
): number {
  const row = db
    .prepare(
      'SELECT COUNT(*) AS n FROM approach_node_runs WHERE revision_id = ? AND node_id = ? AND outcome = ?',
    )
    .get(revisionId, nodeId, outcome) as { n: number };
  return row.n;
}

/** How many of a graph run's node runs sit in one of `statuses`. */
export function countNodeRunsInStatusesForGraphRun(
  db: GraphDb,
  graphRunId: number,
  statuses: readonly string[],
): number {
  const placeholders = statuses.map(() => '?').join(', ');
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM approach_node_runs
       WHERE graph_run_id = ? AND status IN (${placeholders})`,
    )
    .get(graphRunId, ...statuses) as { n: number };
  return row.n;
}

/** The node run a claiming token points at (full row), or undefined. */
export function nodeRunForClaimingToken(db: GraphDb, tokenId: number): NodeRunRow | undefined {
  return db
    .prepare(
      `SELECT r.* FROM approach_node_runs r
       JOIN approach_graph_tokens t ON t.claiming_node_run_id = r.id
       WHERE t.id = ?`,
    )
    .get(tokenId) as NodeRunRow | undefined;
}

/** The launch identity a reattach compares against a live session (node runs). */
export function nodeRunSessionIdentity(
  db: GraphDb,
  id: number,
): Pick<NodeRunRow, 'graph_run_id' | 'process_run_id' | 'generation' | 'owner_nonce' | 'started_at'> | undefined {
  return db
    .prepare(
      `SELECT graph_run_id, process_run_id, generation, owner_nonce, started_at
       FROM approach_node_runs WHERE id = ?`,
    )
    .get(id) as
    | Pick<NodeRunRow, 'graph_run_id' | 'process_run_id' | 'generation' | 'owner_nonce' | 'started_at'>
    | undefined;
}

/** The discard gate's node shape. */
export function nodeRunDiscardRef(
  db: GraphDb,
  id: number,
): Pick<NodeRunRow, 'id' | 'graph_run_id' | 'revision_id' | 'node_id' | 'node_kind' | 'status'> | undefined {
  return db
    .prepare(
      'SELECT id, graph_run_id, revision_id, node_id, node_kind, status FROM approach_node_runs WHERE id = ?',
    )
    .get(id) as
    | Pick<NodeRunRow, 'id' | 'graph_run_id' | 'revision_id' | 'node_id' | 'node_kind' | 'status'>
    | undefined;
}

/** The activation routing shape (revision, node, graph). */
export function nodeRunActivationRef(
  db: GraphDb,
  id: number,
): Pick<NodeRunRow, 'revision_id' | 'node_id' | 'graph_run_id'> | undefined {
  return db
    .prepare('SELECT revision_id, node_id, graph_run_id FROM approach_node_runs WHERE id = ?')
    .get(id) as Pick<NodeRunRow, 'revision_id' | 'node_id' | 'graph_run_id'> | undefined;
}

/** The recovery-retry shape of a re-armable node run. */
export function nodeRunRetryRef(
  db: GraphDb,
  id: number,
): Pick<NodeRunRow, 'id' | 'revision_id' | 'node_id' | 'node_kind' | 'status'> | undefined {
  return db
    .prepare(
      'SELECT id, revision_id, node_id, node_kind, status FROM approach_node_runs WHERE id = ?',
    )
    .get(id) as Pick<NodeRunRow, 'id' | 'revision_id' | 'node_id' | 'node_kind' | 'status'> | undefined;
}

/** The integration pipeline's node shape. */
export function nodeRunIntegrationRef(
  db: GraphDb,
  id: number,
): Pick<NodeRunRow, 'id' | 'graph_run_id' | 'revision_id' | 'node_id' | 'status'> | undefined {
  return db
    .prepare(
      'SELECT id, graph_run_id, revision_id, node_id, status FROM approach_node_runs WHERE id = ?',
    )
    .get(id) as
    | Pick<NodeRunRow, 'id' | 'graph_run_id' | 'revision_id' | 'node_id' | 'status'>
    | undefined;
}

/** The declared-writes claim resolution shape. */
export function nodeRunClaimedWritesRef(
  db: GraphDb,
  id: number,
): Pick<NodeRunRow, 'node_id' | 'node_kind' | 'graph_run_id'> | undefined {
  return db
    .prepare('SELECT node_id, node_kind, graph_run_id FROM approach_node_runs WHERE id = ?')
    .get(id) as Pick<NodeRunRow, 'node_id' | 'node_kind' | 'graph_run_id'> | undefined;
}

/** The (node run id, pid) pairs of a graph run's processes, in id order. A
 *  NULL pid carries no liveness evidence. */
export function nodeRunProcessPids(
  db: GraphDb,
  graphRunId: number,
): Array<{ id: number; pid: number | null }> {
  return db
    .prepare(
      `SELECT n.id AS id, p.pid AS pid
       FROM approach_node_runs n
       JOIN process_runs p ON p.id = n.process_run_id
       WHERE n.graph_run_id = ?
       ORDER BY n.id`,
    )
    .all(graphRunId) as Array<{ id: number; pid: number | null }>;
}

/** The earliest node run of a graph run in one of `statuses`, or undefined. */
export function earliestNodeRunInStatuses(
  db: GraphDb,
  graphRunId: number,
  statuses: readonly string[],
): Pick<NodeRunRow, 'id' | 'status' | 'reason'> | undefined {
  const placeholders = statuses.map(() => '?').join(', ');
  return db
    .prepare(
      `SELECT id, status, reason FROM approach_node_runs
       WHERE graph_run_id = ? AND status IN (${placeholders})
       ORDER BY id LIMIT 1`,
    )
    .get(graphRunId, ...statuses) as
    | Pick<NodeRunRow, 'id' | 'status' | 'reason'>
    | undefined;
}

/** The earliest node run id of a graph run in one of `statuses`, or undefined. */
export function firstNodeRunIdInStatuses(
  db: GraphDb,
  graphRunId: number,
  statuses: readonly string[],
): number | undefined {
  const row = earliestNodeRunInStatuses(db, graphRunId, statuses);
  return row?.id;
}

/** The earliest node run of a graph run in one of `statuses` with its outcome —
 *  the "which node blocked the run" read. */
export function earliestNodeRunOutcomeForGraphRun(
  db: GraphDb,
  graphRunId: number,
  statuses: readonly string[],
): Pick<NodeRunRow, 'id' | 'reason' | 'outcome'> | undefined {
  const placeholders = statuses.map(() => '?').join(', ');
  return db
    .prepare(
      `SELECT id, reason, outcome FROM approach_node_runs
       WHERE graph_run_id = ? AND status IN (${placeholders})
       ORDER BY id LIMIT 1`,
    )
    .get(graphRunId, ...statuses) as
    | Pick<NodeRunRow, 'id' | 'reason' | 'outcome'>
    | undefined;
}

/** The node runs of a graph run in one of `statuses` (recovery-retry shape). */
export function nodeRunsInStatusesForGraphRun(
  db: GraphDb,
  graphRunId: number,
  statuses: readonly string[],
): Array<Pick<NodeRunRow, 'id' | 'revision_id' | 'node_id' | 'node_kind' | 'status'>> {
  const placeholders = statuses.map(() => '?').join(', ');
  return db
    .prepare(
      `SELECT id, revision_id, node_id, node_kind, status FROM approach_node_runs
       WHERE graph_run_id = ? AND status IN (${placeholders})
       ORDER BY id`,
    )
    .all(graphRunId, ...statuses) as Array<
    Pick<NodeRunRow, 'id' | 'revision_id' | 'node_id' | 'node_kind' | 'status'>
  >;
}

/** The artifact-recheck shape: node runs in one of `statuses`, in id order. */
export function artifactFaultNodeRuns(
  db: GraphDb,
  graphRunId: number,
  statuses: readonly string[],
): Array<Pick<NodeRunRow, 'id' | 'revision_id' | 'node_id' | 'status'>> {
  const placeholders = statuses.map(() => '?').join(', ');
  return db
    .prepare(
      `SELECT id, revision_id, node_id, status FROM approach_node_runs
       WHERE graph_run_id = ? AND status IN (${placeholders})
       ORDER BY id`,
    )
    .all(graphRunId, ...statuses) as Array<
    Pick<NodeRunRow, 'id' | 'revision_id' | 'node_id' | 'status'>
  >;
}

/** The replan reason lines: node runs of a graph run that requested a replan. */
export function replanNodeRunReasons(
  db: GraphDb,
  graphRunId: number,
): Array<Pick<NodeRunRow, 'node_id' | 'reason'>> {
  return db
    .prepare(
      `SELECT node_id, reason FROM approach_node_runs
       WHERE graph_run_id = ? AND outcome = 'replan'
       ORDER BY id`,
    )
    .all(graphRunId) as Array<Pick<NodeRunRow, 'node_id' | 'reason'>>;
}

/** The failure lines of a graph run's node runs (replan failure summary),
 *  bounded to `limit` rows. */
export function nodeRunFailuresForGraphRun(
  db: GraphDb,
  graphRunId: number,
  limit: number,
): Array<Pick<NodeRunRow, 'node_id' | 'failure_category' | 'reason'>> {
  return db
    .prepare(
      `SELECT node_id, failure_category, reason FROM approach_node_runs
       WHERE graph_run_id = ?
         AND (failure_category IS NOT NULL
              OR outcome IN ('failed','not-matched','infrastructure-error',
                             'resource-claim-violated','integration-conflict'))
       ORDER BY id LIMIT ?`,
    )
    .all(graphRunId, limit) as Array<
    Pick<NodeRunRow, 'node_id' | 'failure_category' | 'reason'>
  >;
}

/** The change-set ids a graph run produced, in id order (bounded). */
export function nodeRunChangeSetIdsForGraphRun(
  db: GraphDb,
  graphRunId: number,
  limit: number,
): string[] {
  const rows = db
    .prepare(
      `SELECT change_set_id FROM approach_node_runs
       WHERE graph_run_id = ? AND change_set_id IS NOT NULL
       ORDER BY id LIMIT ?`,
    )
    .all(graphRunId, limit) as Array<{ change_set_id: string }>;
  return rows.map((r) => r.change_set_id);
}

/** The node run ids of a graph run that are safe to clean up. */
export function cleanableNodeRunIdsForGraphRun(db: GraphDb, graphRunId: number): number[] {
  const rows = db
    .prepare(
      `SELECT id FROM approach_node_runs
       WHERE graph_run_id = ? AND status IN ('completed', 'cancelled')
       ORDER BY id`,
    )
    .all(graphRunId) as Array<{ id: number }>;
  return rows.map((r) => r.id);
}

/** The node→graph→ticket→project reference a workspace cleanup resolves. */
export function nodeRunWorkspaceRef(
  db: GraphDb,
  id: number,
): { graph_run_id: number; status: string; ticket_id: number; project_slug: string | null } | undefined {
  return db
    .prepare(
      `SELECT n.graph_run_id, n.status, g.ticket_id, p.slug AS project_slug
       FROM approach_node_runs n
       JOIN approach_graph_runs g ON g.id = n.graph_run_id
       JOIN tickets t ON t.id = g.ticket_id
       LEFT JOIN projects p ON p.id = t.project_id
       WHERE n.id = ?`,
    )
    .get(id) as
    | { graph_run_id: number; status: string; ticket_id: number; project_slug: string | null }
    | undefined;
}

/** True when a node run of `graphRunId` exists OUTSIDE `terminalStatuses`
 *  (the adopt/restart check). */
export function nodeRunExistsOutsideStatusesForGraphRun(
  db: GraphDb,
  id: number,
  graphRunId: number,
  terminalStatuses: readonly string[],
): boolean {
  const placeholders = terminalStatuses.map(() => '?').join(', ');
  const row = db
    .prepare(
      `SELECT 1 AS x FROM approach_node_runs
       WHERE id = ? AND graph_run_id = ? AND status NOT IN (${placeholders}) LIMIT 1`,
    )
    .get(id, graphRunId, ...terminalStatuses);
  return row !== undefined;
}

export interface CreateNodeRun {
  graphRunId: number;
  revisionId: number;
  nodeId: string;
  nodeKind: string;
  visitNumber: number;
  now: string;
}

export function createNodeRun(db: GraphDb, input: CreateNodeRun): number {
  const res = db
    .prepare(
      `INSERT INTO approach_node_runs
        (graph_run_id, revision_id, node_id, node_kind, visit_number, status, started_at)
       VALUES (?, ?, ?, ?, ?, 'ready', ?)`,
    )
    .run(
      input.graphRunId,
      input.revisionId,
      input.nodeId,
      input.nodeKind,
      input.visitNumber,
      input.now,
    );
  return Number(res.lastInsertRowid);
}

/** Reserve a node run at claim time WITHOUT `started_at` — the visit is
 *  reserved `ready`, and its clock starts only when the launch claims it. The
 *  claim path is the only caller. */
export function insertReservedNodeRun(
  db: GraphDb,
  input: Omit<CreateNodeRun, 'now'>,
): number {
  const res = db
    .prepare(
      `INSERT INTO approach_node_runs
         (graph_run_id, revision_id, node_id, node_kind, visit_number, status)
       VALUES (?, ?, ?, ?, ?, 'ready')`,
    )
    .run(input.graphRunId, input.revisionId, input.nodeId, input.nodeKind, input.visitNumber);
  return Number(res.lastInsertRowid);
}

/** Move one node run through the DECLARED node-run transition map. Recovery's
 *  retry is the live caller: `blocked` / `failed-to-launch` / `stale` and the
 *  two artifact faults (`output-artifact-missing`, `artifact-unsafe`) all
 *  declare `→ launching`, so a retry never needs a map widened for it. */
export function transitionNodeRun(db: GraphDb, id: number, from: string, to: string): boolean {
  return casStatus(db, 'approach_node_runs', NODE_RUN_TRANSITIONS, id, from, to);
}

/* ------------------------------------------------------------------ */
/* State writes — the ONLY place these columns are written (NDL-38).   */
/* ------------------------------------------------------------------ */

/** Record the reason a node run carries (a park, a discard, a retry). The
 *  status transition is the caller's compare-and-set. */
export function setNodeRunReason(db: GraphDb, id: number, reason: string): boolean {
  const res = db.prepare('UPDATE approach_node_runs SET reason = ? WHERE id = ?').run(reason, id);
  return res.changes === 1;
}

/** Stamp a node run's end (`ended_at`). */
export function setNodeRunEndedAt(db: GraphDb, id: number, now: string): boolean {
  const res = db.prepare('UPDATE approach_node_runs SET ended_at = ? WHERE id = ?').run(now, id);
  return res.changes === 1;
}

/** Record a node run's re-snapshotted planner prompt hash (recovery retry). */
export function setNodeRunPromptHash(db: GraphDb, id: number, promptHash: string): boolean {
  const res = db
    .prepare('UPDATE approach_node_runs SET prompt_hash = ? WHERE id = ?')
    .run(promptHash, id);
  return res.changes === 1;
}

/** The launch identity a claim commits with the row: generation, the
 *  capability hash, and the owner nonce. Written INSIDE the claim
 *  transaction so another window can never observe `launching` with no owner
 *  (NDL-34's spawn double-claim window). */
export function setNodeRunLaunchIdentity(
  db: GraphDb,
  id: number,
  identity: { generation: string; capabilityHash: string; ownerNonce: string },
): boolean {
  const res = db
    .prepare(
      'UPDATE approach_node_runs SET generation = ?, capability_hash = ?, owner_nonce = ? WHERE id = ?',
    )
    .run(identity.generation, identity.capabilityHash, identity.ownerNonce, id);
  return res.changes === 1;
}

/** Record the durable process run a launched node run is bound to. */
export function setNodeRunProcessRunId(db: GraphDb, id: number, processRunId: number): boolean {
  const res = db
    .prepare('UPDATE approach_node_runs SET process_run_id = ? WHERE id = ?')
    .run(processRunId, id);
  return res.changes === 1;
}

/** Drop the identity of a launch that is over (owner nonce, process run,
 *  generation). A retry MUST do this — see `clearLaunchIdentity` callers. */
export function clearNodeRunLaunchIdentity(db: GraphDb, id: number): boolean {
  const res = db
    .prepare(
      `UPDATE approach_node_runs
       SET owner_nonce = NULL, process_run_id = NULL, generation = NULL
       WHERE id = ?`,
    )
    .run(id);
  return res.changes === 1;
}

/** A launch retry bumps the attempt counter on the reserved run; it never
 *  creates another logical visit. */
export function incrementNodeRunLaunchAttempt(db: GraphDb, id: number): boolean {
  const res = db
    .prepare('UPDATE approach_node_runs SET launch_attempt = launch_attempt + 1 WHERE id = ?')
    .run(id);
  return res.changes === 1;
}

/** Complete a deterministic node: record its effective outcome and end. */
export function setNodeRunOutcome(db: GraphDb, id: number, outcome: string, now: string): boolean {
  const res = db
    .prepare('UPDATE approach_node_runs SET outcome = ?, ended_at = ? WHERE id = ?')
    .run(outcome, now, id);
  return res.changes === 1;
}

/** Park a node whose launch could not proceed: failure category, reason, end. */
export function setNodeRunFailure(
  db: GraphDb,
  id: number,
  fields: { failureCategory: string; reason: string; now: string },
): boolean {
  const res = db
    .prepare('UPDATE approach_node_runs SET failure_category = ?, reason = ?, ended_at = ? WHERE id = ?')
    .run(fields.failureCategory, fields.reason, fields.now, id);
  return res.changes === 1;
}

/** The parking pipeline's terminal fields: outcome, failure category, reason.
 *  Omitted fields are written NULL. */
export function setNodeRunTerminalFields(
  db: GraphDb,
  id: number,
  fields: { outcome?: string; failureCategory?: string; reason?: string },
): boolean {
  const res = db
    .prepare(
      `UPDATE approach_node_runs
       SET outcome = ?, failure_category = ?, reason = ?
       WHERE id = ?`,
    )
    .run(fields.outcome ?? null, fields.failureCategory ?? null, fields.reason ?? null, id);
  return res.changes === 1;
}

/** The replan budget refusal: the requesting node's effective outcome parks at
 *  `blocked`/`graph-budget-exhausted`, scoped to its own graph run. */
export function setNodeRunBudgetBlock(
  db: GraphDb,
  id: number,
  graphRunId: number,
  reason: string,
): boolean {
  const res = db
    .prepare(
      `UPDATE approach_node_runs
       SET effective_outcome = 'blocked', failure_category = ?, reason = ?
       WHERE id = ? AND graph_run_id = ?`,
    )
    .run(reason, reason, id, graphRunId);
  return res.changes === 1;
}

/** Claim `completing → integrating` as a bare status write (used where the
 *  caller needs the affected-row count without the transition-map throw). */
export function claimNodeRunIntegrating(db: GraphDb, id: number): boolean {
  const res = db
    .prepare(`UPDATE approach_node_runs SET status = 'integrating' WHERE id = ? AND status = 'completing'`)
    .run(id);
  return res.changes === 1;
}

/** Accept a node's integration: the terminal `complete` fields and the change
 *  set id, in one write. */
export function completeNodeRunIntegration(
  db: GraphDb,
  id: number,
  changeSetId: string,
  now: string,
): boolean {
  const res = db
    .prepare(
      `UPDATE approach_node_runs
       SET outcome = 'complete', effective_outcome = 'complete',
           change_set_id = ?, ended_at = ?
       WHERE id = ?`,
    )
    .run(changeSetId, now, id);
  return res.changes === 1;
}

/** The closed set of node-override kinds. */
export type NodeOverrideKind = 'profile' | 'provider' | 'model' | 'effort' | 'prompt';

export const NODE_OVERRIDE_KINDS: readonly NodeOverrideKind[] = [
  'profile',
  'provider',
  'model',
  'effort',
  'prompt',
] as const;

/** The node-run statuses in which a node's configuration is still editable.
 *  The override write's claim gate: once ANY node run for (revision, node)
 *  leaves this set — a claimed/launched/finished visit — the CAS fails. */
export const NODE_OVERRIDE_EDITABLE_STATUSES = ['ready', 'blocked', 'failed-to-launch'] as const;

export interface NodeOverrideRow {
  id: number;
  graph_run_id: number;
  revision_id: number;
  node_id: string;
  kind: NodeOverrideKind;
  value: string;
  row_version: number;
  created_at: string;
  updated_at: string;
}

export interface WriteNodeOverrideInput {
  revisionId: number;
  nodeId: string;
  kind: NodeOverrideKind;
  /** The override payload (JSON-encoded). */
  value: string;
  now: string;
}

export type WriteNodeOverrideResult =
  | { ok: true }
  | { ok: false; reason: 'unknown-revision' | 'claimed' };

/** Whether launch claiming has begun for (revision, node): any node run in a
 *  status beyond the editable set. The write and clear CAS both gate here. */
export function nodeClaimingBegan(db: GraphDb, revisionId: number, nodeId: string): boolean {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM approach_node_runs
       WHERE revision_id = ? AND node_id = ?
         AND status NOT IN (${NODE_OVERRIDE_EDITABLE_STATUSES.map(() => '?').join(',')})`,
    )
    .get(revisionId, nodeId, ...NODE_OVERRIDE_EDITABLE_STATUSES) as { n: number };
  return row.n > 0;
}

/** Read one override for (revision, node, kind), or undefined when absent. */
export function nodeOverrideFor(
  db: GraphDb,
  revisionId: number,
  nodeId: string,
  kind: NodeOverrideKind,
): NodeOverrideRow | undefined {
  return db
    .prepare(
      `SELECT id, graph_run_id, revision_id, node_id, kind, value, row_version, created_at, updated_at
       FROM approach_node_overrides
       WHERE revision_id = ? AND node_id = ? AND kind = ?`,
    )
    .get(revisionId, nodeId, kind) as NodeOverrideRow | undefined;
}

/**
 * Write (or overwrite) a node override for `(revision_id, node_id, kind)`.
 * The claim CAS: the write FAILS once launch claiming has begun for the node
 * (any node run beyond the editable statuses) or the revision is unknown.
 * Otherwise the row is upserted on the natural key, bumping `row_version`.
 *
 * The claim check is FOLDED INTO the write statement (`INSERT … SELECT …
 * WHERE NOT EXISTS (…)`) rather than run as a separate `nodeClaimingBegan()`
 * read: with two statements a concurrent `BEGIN IMMEDIATE` claim could commit
 * between the read and the write and the override would land on a frozen
 * launch (P2-10). One statement makes the check and the write atomic under
 * SQLite's statement-level atomicity, so no such window exists.
 */
export function writeNodeOverride(db: GraphDb, input: WriteNodeOverrideInput): WriteNodeOverrideResult {
  const revision = db
    .prepare('SELECT graph_run_id FROM approach_graph_revisions WHERE id = ?')
    .get(input.revisionId) as { graph_run_id: number } | undefined;
  if (!revision) return { ok: false, reason: 'unknown-revision' };
  const res = db
    .prepare(
      `INSERT INTO approach_node_overrides
         (graph_run_id, revision_id, node_id, kind, value, row_version, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, 0, ?, ?
        WHERE NOT EXISTS (
          SELECT 1 FROM approach_node_runs
           WHERE revision_id = ? AND node_id = ?
             AND status NOT IN (${NODE_OVERRIDE_EDITABLE_STATUSES.map(() => '?').join(',')})
        )
       ON CONFLICT(revision_id, node_id, kind) DO UPDATE SET
         value = excluded.value,
         row_version = row_version + 1,
         updated_at = excluded.updated_at`,
    )
    .run(
      revision.graph_run_id,
      input.revisionId,
      input.nodeId,
      input.kind,
      input.value,
      input.now,
      input.now,
      input.revisionId,
      input.nodeId,
      ...NODE_OVERRIDE_EDITABLE_STATUSES,
    );
  // Zero rows means the SELECT produced nothing: claiming has begun. (A
  // revision that vanished mid-write cannot happen — revisions are never
  // deleted — so `claimed` is the only other outcome.)
  return res.changes === 1 ? { ok: true } : { ok: false, reason: 'claimed' };
}

/** Clear a node override. Same claim gate as the write — a frozen launch's
 *  configuration is never mutated. The gate is folded into the DELETE so a
 *  concurrent claim cannot slip between the check and the write (P2-10).
 *  Returns false when nothing was removed (no row, or claiming has begun). */
export function clearNodeOverride(
  db: GraphDb,
  input: { revisionId: number; nodeId: string; kind: NodeOverrideKind },
): boolean {
  const res = db
    .prepare(
      `DELETE FROM approach_node_overrides
        WHERE revision_id = ? AND node_id = ? AND kind = ?
          AND NOT EXISTS (
            SELECT 1 FROM approach_node_runs
             WHERE revision_id = ? AND node_id = ?
               AND status NOT IN (${NODE_OVERRIDE_EDITABLE_STATUSES.map(() => '?').join(',')})
          )`,
    )
    .run(
      input.revisionId,
      input.nodeId,
      input.kind,
      input.revisionId,
      input.nodeId,
      ...NODE_OVERRIDE_EDITABLE_STATUSES,
    );
  return res.changes > 0;
}

/** One repository's canonical integration head, observed at claim time (Slice
 *  5 Task 1). Keyed by the physical-domain key (`integration/domains.ts`), so
 *  several manifest entries sharing a worktree record one head. */
export interface BaseHead {
  domainKey: string;
  commit: string;
}

export function encodeBaseHeads(heads: readonly BaseHead[]): string | null {
  return heads.length === 0 ? null : JSON.stringify(heads);
}

/** Decode a `base_heads` column. Anything that is not an array of well-formed
 *  `{domainKey, commit}` pairs is treated as absent — never a half-truth. */
export function decodeBaseHeads(json: string | null): BaseHead[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (h): h is BaseHead =>
        typeof h === 'object'
        && h !== null
        && typeof (h as BaseHead).domainKey === 'string'
        && typeof (h as BaseHead).commit === 'string',
    );
  } catch {
    return [];
  }
}

/** Record the claim-time base heads on a node run. The affected-row check is
 *  the contract: this runs inside the claim transaction, so exactly one row —
 *  the run just created — must move. */
export function writeNodeRunBaseHeads(
  db: GraphDb,
  nodeRunId: number,
  heads: readonly BaseHead[],
): boolean {
  const res = db
    .prepare('UPDATE approach_node_runs SET base_heads = ? WHERE id = ?')
    .run(encodeBaseHeads(heads), nodeRunId);
  return res.changes === 1;
}

/** The base heads recorded on a node run at claim time, or [] when none. */
export function nodeRunBaseHeads(db: GraphDb, nodeRunId: number): BaseHead[] {
  const row = db
    .prepare('SELECT base_heads FROM approach_node_runs WHERE id = ?')
    .get(nodeRunId) as { base_heads: string | null } | undefined;
  return decodeBaseHeads(row?.base_heads ?? null);
}

/** One durable workspace-ledger row (Slice 5 Task 1): a clone created for a
 *  node run and the byte count it contributes to the graph run's total. */
export interface WorkspaceRow {
  id: number;
  graph_run_id: number;
  node_run_id: number;
  repo_name: string;
  cwd: string;
  byte_size: number;
  created_at: string;
}

/** The graph run's durable workspace byte total (`workspace_bytes`, v39). */
export function workspaceBytesOf(db: GraphDb, graphRunId: number): number {
  const row = db
    .prepare('SELECT workspace_bytes FROM approach_graph_runs WHERE id = ?')
    .get(graphRunId) as { workspace_bytes: number } | undefined;
  return row?.workspace_bytes ?? 0;
}

/** Add `bytes` to the graph run's workspace total. The affected-row check
 *  makes the increment a claim: inside the caller's `BEGIN IMMEDIATE` it is
 *  the double-spend guard for the aggregate byte ceiling. */
export function addWorkspaceBytes(db: GraphDb, graphRunId: number, bytes: number): boolean {
  if (bytes < 0) throw new Error('addWorkspaceBytes: negative bytes');
  const res = db
    .prepare('UPDATE approach_graph_runs SET workspace_bytes = workspace_bytes + ? WHERE id = ?')
    .run(bytes, graphRunId);
  return res.changes === 1;
}

/** Release `bytes` from the graph run's total, never below zero. */
export function releaseWorkspaceBytes(db: GraphDb, graphRunId: number, bytes: number): boolean {
  if (bytes < 0) throw new Error('releaseWorkspaceBytes: negative bytes');
  const res = db
    .prepare(
      'UPDATE approach_graph_runs SET workspace_bytes = MAX(0, workspace_bytes - ?) WHERE id = ?',
    )
    .run(bytes, graphRunId);
  return res.changes === 1;
}

/** Record one created workspace in the ledger. */
export function recordWorkspace(
  db: GraphDb,
  input: { graphRunId: number; nodeRunId: number; repoName: string; cwd: string; byteSize: number; now: string },
): number {
  const res = db
    .prepare(
      `INSERT INTO approach_graph_workspaces
         (graph_run_id, node_run_id, repo_name, cwd, byte_size, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(input.graphRunId, input.nodeRunId, input.repoName, input.cwd, input.byteSize, input.now);
  return Number(res.lastInsertRowid);
}

/** The workspace-ledger rows of a node run (the bytes cleanup must release). */
export function workspacesForNode(db: GraphDb, nodeRunId: number): WorkspaceRow[] {
  return db
    .prepare(
      `SELECT id, graph_run_id, node_run_id, repo_name, cwd, byte_size, created_at
       FROM approach_graph_workspaces WHERE node_run_id = ? ORDER BY id`,
    )
    .all(nodeRunId) as WorkspaceRow[];
}

/** Remove a node run's workspace-ledger rows. Idempotent. */
export function removeWorkspacesForNode(db: GraphDb, nodeRunId: number): number {
  const res = db.prepare('DELETE FROM approach_graph_workspaces WHERE node_run_id = ?').run(nodeRunId);
  return res.changes;
}

/**
 * The deferral ledger (Slice 5 Task 3). One row per READY-BUT-BLOCKED node in
 * a revision: the reason the scheduler refused its activation and the first
 * moment it became blocked (`wait_since` — the bounded-aging clock). Keyed by
 * `(revision_id, node_id)` because the node run does not exist until its claim
 * succeeds — a deferral describes a node waiting to be claimed, never a
 * claimed run. Inside reads it so deliberate serialization never looks like a
 * scheduler defect.
 */
export interface DeferralRow {
  id: number;
  graph_run_id: number;
  revision_id: number;
  node_id: string;
  reason: string;
  wait_since: string;
  updated_at: string;
}

/** The deferral for a node in a revision, or undefined when not deferred. */
export function deferralFor(db: GraphDb, revisionId: number, nodeId: string): DeferralRow | undefined {
  return db
    .prepare(
      `SELECT id, graph_run_id, revision_id, node_id, reason, wait_since, updated_at
         FROM approach_node_deferrals WHERE revision_id = ? AND node_id = ?`,
    )
    .get(revisionId, nodeId) as DeferralRow | undefined;
}

/**
 * Record (or refresh) a node's deferral. The FIRST deferral stamps
 * `wait_since` (the bounded-aging clock — it never moves); a later refusal
 * only refreshes the reason and `updated_at`. Returns the effective wait_since
 * and whether this was the first deferral.
 */
export function recordDeferral(
  db: GraphDb,
  input: { graphRunId: number; revisionId: number; nodeId: string; reason: string; now: string },
): { waitSince: string; fresh: boolean } {
  const existing = deferralFor(db, input.revisionId, input.nodeId);
  if (existing) {
    db.prepare(
      'UPDATE approach_node_deferrals SET reason = ?, updated_at = ? WHERE id = ?',
    ).run(input.reason, input.now, existing.id);
    return { waitSince: existing.wait_since, fresh: false };
  }
  db.prepare(
    `INSERT INTO approach_node_deferrals (graph_run_id, revision_id, node_id, reason, wait_since, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(input.graphRunId, input.revisionId, input.nodeId, input.reason, input.now, input.now);
  return { waitSince: input.now, fresh: true };
}

/** Clear a node's deferral — the claim succeeded, or the node became
 *  dependency-waiting (never resource-blocked), or the run stopped. Returns
 *  whether a row was removed. */
export function clearDeferral(db: GraphDb, revisionId: number, nodeId: string): boolean {
  const res = db.prepare(
    'DELETE FROM approach_node_deferrals WHERE revision_id = ? AND node_id = ?',
  ).run(revisionId, nodeId);
  return res.changes > 0;
}

/** A graph run's deferral rows, ordered by node id. */
export function deferralsForGraphRun(db: GraphDb, graphRunId: number): DeferralRow[] {
  return db
    .prepare(
      `SELECT id, graph_run_id, revision_id, node_id, reason, wait_since, updated_at
         FROM approach_node_deferrals WHERE graph_run_id = ? ORDER BY node_id`,
    )
    .all(graphRunId) as DeferralRow[];
}

/**
 * The graph run's `active_processes` counter — the coordinator's own accounting
 * of the shared external-process ceiling (`graph.limits.maxParallel`). It
 * counts agent sessions AND per-repository command subprocesses: one slot per
 * claimed agent/command activation (a command node runs its repositories
 * serially, so its subprocesses never exceed one slot at a time). Gates and
 * joins spawn nothing and never reserve a slot. Reserved in the claim
 * transaction (the atomic ceiling CAS is the multi-window enforcement),
 * released only when the process provably ends (pipeline integration) or the
 * ambiguous run is discarded — a rest state keeps its slot until then, which
 * is conservative: recovery can never oversubscribe real processes.
 */
export function activeProcessesOf(db: GraphDb, graphRunId: number): number {
  const row = db
    .prepare('SELECT active_processes FROM approach_graph_runs WHERE id = ?')
    .get(graphRunId) as { active_processes: number } | undefined;
  return row?.active_processes ?? 0;
}

/** Atomically reserve one process slot, refusing when the ceiling is reached.
 *  The affected-row check makes the reserve a claim: under `BEGIN IMMEDIATE`
 *  two windows cannot both pass the ceiling. */
export function reserveProcessSlot(db: GraphDb, graphRunId: number, maxParallel: number): boolean {
  const res = db
    .prepare(
      'UPDATE approach_graph_runs SET active_processes = active_processes + 1 WHERE id = ? AND active_processes < ?',
    )
    .run(graphRunId, maxParallel);
  return res.changes === 1;
}

/** Release one process slot, never below zero (a run whose slot is not held
 *  must not be driven negative). Idempotent. */
export function releaseProcessSlot(db: GraphDb, graphRunId: number): boolean {
  const res = db
    .prepare(
      'UPDATE approach_graph_runs SET active_processes = MAX(0, active_processes - 1) WHERE id = ?',
    )
    .run(graphRunId);
  return res.changes === 1;
}
