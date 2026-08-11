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
  claimedPaths: string;
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
