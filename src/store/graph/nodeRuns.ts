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

export function transitionNodeRun(db: GraphDb, id: number, from: string, to: string): boolean {
  return casStatus(db, 'approach_node_runs', NODE_RUN_TRANSITIONS, id, from, to);
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
 */
export function writeNodeOverride(db: GraphDb, input: WriteNodeOverrideInput): WriteNodeOverrideResult {
  const revision = db
    .prepare('SELECT graph_run_id FROM approach_graph_revisions WHERE id = ?')
    .get(input.revisionId) as { graph_run_id: number } | undefined;
  if (!revision) return { ok: false, reason: 'unknown-revision' };
  if (nodeClaimingBegan(db, input.revisionId, input.nodeId)) return { ok: false, reason: 'claimed' };
  db.prepare(
    `INSERT INTO approach_node_overrides
       (graph_run_id, revision_id, node_id, kind, value, row_version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?)
     ON CONFLICT(revision_id, node_id, kind) DO UPDATE SET
       value = excluded.value,
       row_version = row_version + 1,
       updated_at = excluded.updated_at`,
  ).run(revision.graph_run_id, input.revisionId, input.nodeId, input.kind, input.value, input.now, input.now);
  return { ok: true };
}

/** Clear a node override. Same claim gate as the write — a frozen launch's
 *  configuration is never mutated. Returns false when nothing was removed. */
export function clearNodeOverride(
  db: GraphDb,
  input: { revisionId: number; nodeId: string; kind: NodeOverrideKind },
): boolean {
  if (nodeClaimingBegan(db, input.revisionId, input.nodeId)) return false;
  const res = db
    .prepare(
      `DELETE FROM approach_node_overrides
       WHERE revision_id = ? AND node_id = ? AND kind = ?`,
    )
    .run(input.revisionId, input.nodeId, input.kind);
  return res.changes > 0;
}
