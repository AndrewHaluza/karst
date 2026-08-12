/**
 * Activation-token store (Slice 2 Task 2 shape; Slice 3 Task 1 claims).
 *
 * A token records the source node run, edge, destination, graph revision,
 * fork-lineage stack, and claim/consumption status. Synthetic entry tokens
 * have no source and share the root fork instance (`is_entry = 1`).
 *
 * Entry-token shape: `source_node_run_id INTEGER NULL` plus `is_entry` —
 * a closed-value CHECK over a nullable FK cannot express "a real reference or
 * the sentinel", so the shape rule lives in application code: a null source
 * is accepted ONLY for the entry token (`createToken` enforces it).
 *
 * Successor insertion is IDEMPOTENT under a duplicated completion: the
 * uniqueness constraint `(source_node_run_id, edge_id, fork_instance)` stays
 * in the schema, but `createToken` inserts with `OR IGNORE` — a second insert
 * of the same successor is a no-op returning undefined, never an error and
 * never a second row, so a completion raced by two windows cannot throw
 * mid-transaction (Slice 3 Task 1).
 *
 * The transition map (`TOKEN_TRANSITIONS`) permits `pending → claimed →
 * consumed` and `→ cancelled`; there is deliberately NO `claimed → pending`
 * transition — a launch retry keeps the token claimed and reuses the
 * reserved visit (`claimGraphToken`/`consumeGraphToken`/`cancelGraphToken`
 * are the claim-path CASes; `transitionToken` is the generic wrapper).
 *
 * Driver-agnostic by contract (positional `?` only) — the CLI opens the same
 * store with `node:sqlite`.
 */

import type { GraphDb } from './transitions.js';
import { GraphStoreError, TOKEN_TRANSITIONS, casStatus } from './transitions.js';

export interface CreateToken {
  revisionId: number;
  /** NULL only for the entry token (`isEntry = 1`). */
  sourceNodeRunId: number | null;
  isEntry: 0 | 1;
  edgeId: string;
  destinationNodeId: string;
  destinationEnd: 0 | 1;
  forkInstance: number;
  forkLineage: string | null;
  now: string;
}

export interface GraphTokenRow {
  id: number;
  revision_id: number;
  source_node_run_id: number | null;
  is_entry: number;
  edge_id: string;
  destination_node_id: string | null;
  destination_end: number;
  fork_instance: number;
  fork_lineage: string | null;
  status: string;
  claiming_node_run_id: number | null;
  consuming_node_run_id: number | null;
  created_at: string;
  consumed_at: string | null;
}

/**
 * Insert a token, enforcing the entry-token shape. Returns the new id, or
 * undefined when the `(source_node_run_id, edge_id, fork_instance)` triple
 * already exists — a duplicated completion's second insert is deliberately
 * ignored. Entry tokens (null source) never collide: NULLs are distinct in
 * the UNIQUE index, so an entry edge may be re-seeded freely.
 */
export function createToken(db: GraphDb, input: CreateToken): number | undefined {
  if (input.sourceNodeRunId === null && input.isEntry !== 1) {
    throw new GraphStoreError(
      'a token with a null source node run must be the entry token (is_entry = 1)',
    );
  }
  if (input.sourceNodeRunId !== null && input.isEntry !== 0) {
    throw new GraphStoreError('only the entry token may carry is_entry = 1');
  }
  const res = db
    .prepare(
      `INSERT OR IGNORE INTO approach_graph_tokens
        (revision_id, source_node_run_id, is_entry, edge_id, destination_node_id,
         destination_end, fork_instance, fork_lineage, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    )
    .run(
      input.revisionId,
      input.sourceNodeRunId,
      input.isEntry,
      input.edgeId,
      input.destinationNodeId,
      input.destinationEnd,
      input.forkInstance,
      input.forkLineage,
      input.now,
    );
  return res.changes === 1 ? Number(res.lastInsertRowid) : undefined;
}

/** Insert a successor token — `createToken` with boolean flags. */
export interface InsertGraphToken {
  revisionId: number;
  /** NULL only for the entry token (`isEntry = true`). */
  sourceNodeRunId: number | null;
  isEntry: boolean;
  edgeId: string;
  destinationNodeId: string;
  destinationEnd: boolean;
  forkInstance: number;
  forkLineage: string | null;
  now: string;
}

export function insertGraphToken(db: GraphDb, input: InsertGraphToken): number | undefined {
  return createToken(db, {
    revisionId: input.revisionId,
    sourceNodeRunId: input.sourceNodeRunId,
    isEntry: input.isEntry ? 1 : 0,
    edgeId: input.edgeId,
    destinationNodeId: input.destinationNodeId,
    destinationEnd: input.destinationEnd ? 1 : 0,
    forkInstance: input.forkInstance,
    forkLineage: input.forkLineage,
    now: input.now,
  });
}

/** Create the synthetic entry tokens for a revision: no source node run,
 *  `is_entry = 1`, sharing the root fork instance (instance 0, "root"). */
export function insertEntryTokens(
  db: GraphDb,
  revisionId: number,
  edges: readonly { edgeId: string; destinationNodeId: string; destinationEnd: boolean }[],
  now: string,
): number[] {
  const ids: number[] = [];
  for (const edge of edges) {
    const id = createToken(db, {
      revisionId,
      sourceNodeRunId: null,
      isEntry: 1,
      edgeId: edge.edgeId,
      destinationNodeId: edge.destinationNodeId,
      destinationEnd: edge.destinationEnd ? 1 : 0,
      forkInstance: 0,
      forkLineage: 'root',
      now,
    });
    if (id !== undefined) ids.push(id);
  }
  return ids;
}

export function graphTokenById(db: GraphDb, id: number): GraphTokenRow | undefined {
  return db.prepare('SELECT * FROM approach_graph_tokens WHERE id = ?').get(id) as
    | GraphTokenRow
    | undefined;
}

/** The coordinator's selection set: pending tokens, oldest first. */
export function pendingTokensForRevision(db: GraphDb, revisionId: number): GraphTokenRow[] {
  return db
    .prepare(
      "SELECT * FROM approach_graph_tokens WHERE revision_id = ? AND status = 'pending' ORDER BY id",
    )
    .all(revisionId) as GraphTokenRow[];
}

/** The generic transition CAS over the token map (T2 surface). */
export function transitionToken(db: GraphDb, id: number, from: string, to: string): boolean {
  return casStatus(db, 'approach_graph_tokens', TOKEN_TRANSITIONS, id, from, to);
}

/** Compare-and-set `pending → claimed`, stamping the claiming node run.
 *  Returns false when the token already moved — a raced claim is a no-op. */
export function claimGraphToken(db: GraphDb, id: number, claimingNodeRunId: number): boolean {
  const res = db
    .prepare(
      `UPDATE approach_graph_tokens
       SET status = 'claimed', claiming_node_run_id = ?
       WHERE id = ? AND status = 'pending'`,
    )
    .run(claimingNodeRunId, id);
  return res.changes === 1;
}

/** Compare-and-set `claimed → consumed`, stamping the consuming run. */
export function consumeGraphToken(
  db: GraphDb,
  id: number,
  consumingNodeRunId: number,
  now: string,
): boolean {
  const res = db
    .prepare(
      `UPDATE approach_graph_tokens
       SET status = 'consumed', consuming_node_run_id = ?, consumed_at = ?
       WHERE id = ? AND status = 'claimed'`,
    )
    .run(consumingNodeRunId, now, id);
  return res.changes === 1;
}

/** Cancel a pending or claimed token. A claimed token may be cancelled; there
 *  is no `claimed → pending` transition and this is not one. */
export function cancelGraphToken(db: GraphDb, id: number): boolean {
  const res = db
    .prepare(
      `UPDATE approach_graph_tokens SET status = 'cancelled' WHERE id = ? AND status IN ('pending', 'claimed')`,
    )
    .run(id);
  return res.changes === 1;
}
