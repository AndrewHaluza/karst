/**
 * Revision store: monotonic revision numbers per run and the DERIVED active
 * revision — never a stored column, following the read-filtered derivation
 * precedent in `store/mergeChecks.ts`. The partial unique index on
 * `(graph_run_id) WHERE status = 'active'` makes "at most one active
 * revision" structural.
 */

import type { GraphDb } from './transitions.js';
import { REVISION_TRANSITIONS, casStatus } from './transitions.js';

export type RevisionStatus = 'active' | 'draining' | 'superseded' | 'completed';

export interface RevisionRow {
  id: number;
  graph_run_id: number;
  revision_number: number;
  canonical_graph: string;
  fingerprint: string;
  status: RevisionStatus;
  supersedes_revision_id: number | null;
  created_at: string;
}

export interface CreateRevision {
  graphRunId: number;
  revisionNumber: number;
  canonicalGraph: string;
  fingerprint: string;
  status: RevisionStatus;
  now: string;
  supersedesRevisionId?: number;
  reason?: string;
}

export function createRevision(db: GraphDb, input: CreateRevision): number {
  const res = db
    .prepare(
      `INSERT INTO approach_graph_revisions
        (graph_run_id, revision_number, canonical_graph, fingerprint, status,
         supersedes_revision_id, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.graphRunId,
      input.revisionNumber,
      input.canonicalGraph,
      input.fingerprint,
      input.status,
      input.supersedesRevisionId ?? null,
      input.reason ?? null,
      input.now,
    );
  return Number(res.lastInsertRowid);
}

/** The single active revision of a graph run, or undefined. */
export function activeRevision(db: GraphDb, graphRunId: number): RevisionRow | undefined {
  return db
    .prepare(
      'SELECT * FROM approach_graph_revisions WHERE graph_run_id = ? AND status = ?',
    )
    .get(graphRunId, 'active') as RevisionRow | undefined;
}

export function transitionRevision(db: GraphDb, id: number, from: string, to: string): boolean {
  return casStatus(db, 'approach_graph_revisions', REVISION_TRANSITIONS, id, from, to);
}
