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

/** Encode a claimed-path list for the lease column: a repository-wide lease
 *  (no paths) records NULL — the T2 domain-level shape, and the shape a null
 *  decoded later reads as repository-wide, which overlaps everything. */
export function encodeLeasePaths(paths: readonly string[]): string | null {
  return paths.length === 0 ? null : JSON.stringify([...paths].sort());
}

/** Decode a lease's claimed paths. NULL — the T2 domain-level lease — is
 *  repository-wide: it overlaps EVERY path, because the holder's granularity
 *  was never narrowed. Anything that is not a JSON array is equally unknown
 *  and treated the same. */
export function decodeLeasePaths(json: string | null): string[] {
  if (json === null) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((p): p is string => typeof p === 'string');
  } catch {
    return [];
  }
}

export function transitionLease(db: GraphDb, id: number, from: string, to: string): boolean {
  return casStatus(db, 'approach_resource_leases', LEASE_TRANSITIONS, id, from, to);
}

export interface LeaseRow {
  id: number;
  status: string;
}

/**
 * Whether ANOTHER node run's lease blocks the incoming access to the domain —
 * the pre-check that refuses a conflicting claim, and the SCHEDULER's conflict
 * decision (Slice 5 Task 3). The conflict rules: an `ambiguous-process` lease
 * blocks everything (its access is unknowable — the process may still write);
 * read/read on the domain may coexist; otherwise at least one side writes and
 * the claimed-path sets decide (a repository-wide lease — NULL `claimed_paths`
 * — overlaps every path). The domain's own owner is excluded: a node run never
 * conflicts with its own lease. Because the claim runs inside `BEGIN
 * IMMEDIATE`, a second window's pre-check reads the first window's COMMITTED
 * row, so the affected-row check is enforcement rather than convention.
 */
export function leaseConflictsWith(
  db: GraphDb,
  physicalDomain: string,
  ownerNodeRunId: number,
  incoming: { accessMode: 'read' | 'write'; paths: readonly string[] },
): boolean {
  const rows = db
    .prepare(
      `SELECT status, access_mode, claimed_paths FROM approach_resource_leases
       WHERE physical_domain = ? AND status IN ('held','ambiguous-process') AND owner_node_run_id != ?`,
    )
    .all(physicalDomain, ownerNodeRunId) as {
    status: string;
    access_mode: string;
    claimed_paths: string | null;
  }[];
  for (const row of rows) {
    if (row.status === 'ambiguous-process') return true;
    if (incoming.accessMode === 'read' && row.access_mode === 'read') continue;
    const heldPaths = decodeLeasePaths(row.claimed_paths);
    if (pathSetsOverlap(incoming.paths, heldPaths)) return true;
  }
  return false;
}

/** The path-list overlap predicate shared by the lease conflict decision and
 *  the scheduler — an empty list is repository-wide (overlaps every path). */
function pathSetsOverlap(a: readonly string[], b: readonly string[]): boolean {
  if (a.length === 0 || b.length === 0) return true;
  const strip = (p: string): string => {
    let end = p.length;
    while (end > 0 && p[end - 1] === '/') end -= 1;
    return p.slice(0, end);
  };
  for (const p of a) {
    for (const q of b) {
      const x = strip(p);
      const y = strip(q);
      if (x === '' || y === '' || x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`)) return true;
    }
  }
  return false;
}

/** One held lease as the scheduler's pre-claim admission reads it: the domain,
 *  its access, whether the owner's process death is unprovable, and the
 *  claimed paths ([] = repository-wide). READ-only — the scheduler never
 *  mutates leases; the claim's `acquireDomainLeases` is the writer. */
export interface SchedulerLeaseRow {
  physicalDomain: string;
  accessMode: 'read' | 'write';
  ambiguous: boolean;
  paths: string[];
}

/** Every `held`/`ambiguous-process` lease in the store, other-owner excluded
 *  by the caller — the snapshot the sweep hands `schedulerReady`. */
export function heldLeasesForScheduler(db: GraphDb): SchedulerLeaseRow[] {
  const rows = db
    .prepare(
      `SELECT physical_domain, access_mode, claimed_paths, status
       FROM approach_resource_leases
       WHERE status IN ('held','ambiguous-process')
       ORDER BY physical_domain, id`,
    )
    .all() as {
    physical_domain: string;
    access_mode: string;
    claimed_paths: string | null;
    status: string;
  }[];
  return rows.map((row) => ({
    physicalDomain: row.physical_domain,
    accessMode: row.access_mode === 'read' ? 'read' : 'write',
    ambiguous: row.status === 'ambiguous-process',
    paths: decodeLeasePaths(row.claimed_paths),
  }));
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
