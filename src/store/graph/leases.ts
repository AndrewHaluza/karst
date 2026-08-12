/**
 * Resource-lease store. The uniqueness constraint
 * `UNIQUE(owner_node_run_id, physical_domain)` is load-bearing: without it two
 * windows insert duplicate leases and the affected-row checks become
 * enforcement-by-code.
 */

import type { GraphDb } from './transitions.js';
import { LEASE_TRANSITIONS, casStatus } from './transitions.js';

export interface AcquireLease {
  graphRunId: number;
  ownerNodeRunId: number;
  physicalDomain: string;
  accessMode: string;
  /** The claimed paths, when the lease is path-granular; a domain-level lease
   *  (Slice 5 Task 2) records none. */
  claimedPaths: string | null;
  now: string;
}

export function acquireLease(db: GraphDb, input: AcquireLease): number {
  const res = db
    .prepare(
      `INSERT INTO approach_resource_leases
        (graph_run_id, owner_node_run_id, physical_domain, access_mode, claimed_paths, status, acquired_at)
       VALUES (?, ?, ?, ?, ?, 'held', ?)`,
    )
    .run(
      input.graphRunId,
      input.ownerNodeRunId,
      input.physicalDomain,
      input.accessMode,
      input.claimedPaths,
      input.now,
    );
  return Number(res.lastInsertRowid);
}

export function transitionLease(db: GraphDb, id: number, from: string, to: string): boolean {
  return casStatus(db, 'approach_resource_leases', LEASE_TRANSITIONS, id, from, to);
}

export interface LeaseRow {
  id: number;
  status: string;
}

/**
 * Whether ANOTHER node run already holds (or is ambiguous over) the domain —
 * the pre-check that refuses a conflicting claim. The domain's own owner is
 * excluded (`owner_node_run_id != ?`): a node run never conflicts with its own
 * lease. Because the claim runs inside `BEGIN IMMEDIATE`, a second window's
 * pre-check reads the first window's COMMITTED row, so the affected-row check
 * is enforcement rather than convention.
 */
export function leaseConflictsWith(db: GraphDb, physicalDomain: string, ownerNodeRunId: number): boolean {
  const row = db
    .prepare(
      `SELECT id FROM approach_resource_leases
       WHERE physical_domain = ? AND status IN ('held','ambiguous-process') AND owner_node_run_id != ?`,
    )
    .get(physicalDomain, ownerNodeRunId);
  return row !== undefined;
}

export interface ReleaseLeaseOpts {
  /** Release `ambiguous-process` leases too. ONLY the discard action passes
   *  this: `ambiguous-process → released` is the discard's exclusive
   *  transition, and every other caller must leave an ambiguous lease alone —
   *  no lease is released while process termination is unknown. */
  allowAmbiguous?: boolean;
}

/**
 * The node run's leases → `released` through the lease transition map.
 * Without `allowAmbiguous` only `held` leases release — that is the
 * proven-termination completion release. The discard action passes the flag,
 * releasing both `held` and `ambiguous-process`. Returns how many rows moved;
 * an already-released lease moves nothing.
 */
export function releaseLeaseForNodeRun(db: GraphDb, nodeRunId: number, opts: ReleaseLeaseOpts = {}): number {
  const statuses: readonly string[] = opts.allowAmbiguous === true ? ['held', 'ambiguous-process'] : ['held'];
  const rows = db
    .prepare(
      `SELECT id, status FROM approach_resource_leases
       WHERE owner_node_run_id = ? AND status IN (${statuses.map(() => '?').join(',')})`,
    )
    .all(nodeRunId, ...statuses) as LeaseRow[];
  let released = 0;
  for (const row of rows) {
    if (transitionLease(db, row.id, row.status, 'released')) released += 1;
  }
  return released;
}

/**
 * The node run's `held` leases → `ambiguous-process`: the status flip that
 * happens EXACTLY where process termination is unprovable (the reconcile
 * termination-unknown path). Never releases; an already-ambiguous or released
 * lease is left strictly alone. Returns how many rows moved.
 */
export function markLeaseAmbiguous(db: GraphDb, nodeRunId: number): number {
  const rows = db
    .prepare(
      `SELECT id, status FROM approach_resource_leases
       WHERE owner_node_run_id = ? AND status = 'held'`,
    )
    .all(nodeRunId) as LeaseRow[];
  let flipped = 0;
  for (const row of rows) {
    if (transitionLease(db, row.id, row.status, 'ambiguous-process')) flipped += 1;
  }
  return flipped;
}
