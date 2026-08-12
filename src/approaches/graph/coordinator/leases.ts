/**
 * Coordinator-side physical-domain leases (Slice 5 Task 2).
 *
 * Integration and conflicting execution serialize on a DURABLE database-backed
 * lease — an `approach_resource_leases` row with status `held`, acquired in
 * the claim transaction — never an in-memory mutex, because two windows may
 * legitimately complete different nodes concurrently. `UNIQUE(owner_node_run_id,
 * physical_domain)` is what makes the affected-row check enforcement rather
 * than convention.
 *
 * `acquireDomainLeases` runs INSIDE the claim's `BEGIN IMMEDIATE` transaction
 * (the caller supplies the transaction). It is the pre-check + insert pair:
 * a domain already `held` or `ambiguous-process` by ANOTHER node run refuses
 * the whole acquisition, which the claim converts into a `GraphClaimError`
 * abort that rolls the claim back; the sweep catches it and defers the
 * activation. Two windows acquiring the same domain serialize: the second
 * window's pre-check reads the first window's committed row.
 *
 * Release rules, in one place:
 *  - `releaseLeaseForNodeRun` (no flag) — `held → released` after proven
 *    termination AND integration (the pipeline) or preserved-behind-a-blocker
 *    resolution. An `ambiguous-process` lease is left STRICTLY alone.
 *  - `releaseLeaseForNodeRun(…, { allowAmbiguous: true })` — the discard
 *    action's exclusive `ambiguous-process → released` path.
 *  - `markLeaseAmbiguous` — `held → ambiguous-process`, wired into the
 *    reconcile termination-unknown path: the flip happens exactly there.
 *
 * No lease is released while process termination is unknown.
 *
 * Host-agnostic: the durable store primitives are the only dependency; domain
 * resolution (git, worktrees) is the host's `domainsForActivation` callback.
 */

import type { GraphDb } from '../../../store/graph/transitions.js';
import { acquireLease, leaseConflictsWith } from '../../../store/graph/leases.js';

export {
  releaseLeaseForNodeRun,
  markLeaseAmbiguous,
  type ReleaseLeaseOpts,
} from '../../../store/graph/leases.js';

/** One physical domain an activation needs at claim time: the durable domain
 *  key (canonical worktree realpath + Git common-directory identity) and the
 *  access the activation will take over it. The HOST resolves these from the
 *  node's declared claims via the injected `domainsForActivation` callback. */
export interface ActivationDomain {
  physicalDomain: string;
  accessMode: 'read' | 'write';
}

export interface AcquireDomainLeasesDeps {
  db: GraphDb;
  now: () => string;
}

export type DomainLeaseAcquisition =
  | { acquired: true; count: number }
  | { acquired: false; reason: string };

/**
 * Acquire one `held` lease per required physical domain, CALLED INSIDE the
 * claim transaction. Deduplicated by domain key (aliased repository entries
 * resolve to one domain — `write` wins over `read` for the same key). Refuses
 * the WHOLE acquisition — a domain already `held` or `ambiguous-process` by
 * another node run — so the claim rolls back rather than proceeding partially.
 */
export function acquireDomainLeases(
  deps: AcquireDomainLeasesDeps,
  input: { graphRunId: number; nodeRunId: number; domains: readonly ActivationDomain[] },
): DomainLeaseAcquisition {
  const db = deps.db;
  const byDomain = new Map<string, ActivationDomain>();
  for (const domain of input.domains) {
    const existing = byDomain.get(domain.physicalDomain);
    if (!existing || domain.accessMode === 'write') byDomain.set(domain.physicalDomain, domain);
  }
  for (const domain of byDomain.values()) {
    if (leaseConflictsWith(db, domain.physicalDomain, input.nodeRunId)) {
      return {
        acquired: false,
        reason: `physical domain ${domain.physicalDomain} is ${domainStatusText(db, domain.physicalDomain, input.nodeRunId)} by another node run`,
      };
    }
  }
  let count = 0;
  for (const domain of byDomain.values()) {
    acquireLease(db, {
      graphRunId: input.graphRunId,
      ownerNodeRunId: input.nodeRunId,
      physicalDomain: domain.physicalDomain,
      accessMode: domain.accessMode,
      claimedPaths: null,
      now: deps.now(),
    });
    count += 1;
  }
  return { acquired: true, count };
}

/** The blocking status of the conflicting lease, for the refusal reason. */
function domainStatusText(db: GraphDb, physicalDomain: string, ownerNodeRunId: number): string {
  const row = db
    .prepare(
      `SELECT status FROM approach_resource_leases
       WHERE physical_domain = ? AND status IN ('held','ambiguous-process') AND owner_node_run_id != ?
       ORDER BY id LIMIT 1`,
    )
    .get(physicalDomain, ownerNodeRunId) as { status: string } | undefined;
  return row?.status ?? 'held';
}
