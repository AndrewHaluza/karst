/**
 * Token store: the entry-token representation — `source_node_run_id INTEGER
 * NULL` plus `is_entry` — because a closed-value CHECK over a nullable FK
 * cannot express "a real reference or the sentinel". The shape rule lives in
 * application code: a null source is accepted ONLY for the entry token.
 *
 * The four token transitions are the only legal ones (no `claimed → pending`:
 * a launch retry keeps the token claimed and reuses the reserved visit).
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

export function createToken(db: GraphDb, input: CreateToken): number {
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
      `INSERT INTO approach_graph_tokens
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
  return Number(res.lastInsertRowid);
}

export function transitionToken(db: GraphDb, id: number, from: string, to: string): boolean {
  return casStatus(db, 'approach_graph_tokens', TOKEN_TRANSITIONS, id, from, to);
}
