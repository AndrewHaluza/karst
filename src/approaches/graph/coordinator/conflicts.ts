/**
 * Deterministic conflict rules and the scheduler admission (Slice 5 Task 3).
 *
 * The conflict DECISION is pure: `claimsConflict` over path claims plus the
 * injected physical-domain map (`activationDomainKeys`). read/read on the
 * same path may run together; write/write and write/read overlap conflict;
 * directory claims overlap descendants (`p === q` or `p.startsWith(q + '/')` —
 * the separator is load-bearing, so `src` never matches `src-other`);
 * repository-wide claims (`paths === []`) overlap every path in that
 * repository. Command access comes from the PINNED allowlist
 * (`graph.commands`), never planner prose: a command node's access mode is the
 * allowlist entry's, and an unknown command is not trusted — it claims no
 * domains.
 *
 * `schedulerReady` is the pre-claim admission a sweep tick asks BEFORE it
 * claims: no domain conflict with any currently-held lease (an
 * `ambiguous-process` lease blocks everything — its access is unknowable),
 * no conflict with work already admitted in the same tick, under the process
 * ceiling, and never for a dependency-waiting node (a join whose arrivals are
 * not all pending is NOT ready and is never reported as resource-blocked).
 * The admission agrees with what the claim's path-aware lease backstop
 * enforces, so a pre-check "ready" is never contradicted by the claim.
 *
 * Ready ordering is deterministic by activation creation time and token id
 * (token id breaks one-millisecond ties — stated, never hidden), with bounded
 * aging: once a node has waited at least `AGING_THRESHOLD_MS` while
 * ready-but-blocked it is preferred over newer narrow work even if that means
 * serializing, so a wide-resource node cannot starve behind repeatedly
 * generated loop work. Deliberate serialization is a deferral with a reason —
 * never a silent scheduler skip.
 *
 * Host-agnostic: no store, no vscode, no git.
 */

import type { ActivationDomain } from './leases.js';

export type AccessMode = 'read' | 'write';

/** One node claim: the paths the node touches in a repository. `paths === []`
 *  means repository-wide (the node touches everything in that repository). */
export interface ConflictClaim {
  repo: string;
  paths: readonly string[];
  mode: AccessMode;
}

/** A single repository claim inside `resources.reads`/`resources.writes`. */
export interface RepoPathClaim {
  repo: string;
  paths: readonly string[];
}

/** The pinned command allowlist (`ApproachDef.graph.commands`), reduced to
 *  each command's access mode — the ONLY source of a command's access. */
export type AllowlistCommandAccess = ReadonlyMap<string, AccessMode>;

/** The aging bound: a node ready-but-blocked for this long is promoted above
 *  newer narrow work (design, "Bounded aging"). Deliberately 60s — long
 *  enough to absorb a transient narrow burst, short enough that a wide node
 *  is never parked indefinitely behind loop regeneration. */
export const AGING_THRESHOLD_MS = 60_000;

/** Strip trailing separators so `src/` and `src` compare as the same path. */
function stripTrailingSeparator(p: string): string {
  let end = p.length;
  while (end > 0 && p[end - 1] === '/') end -= 1;
  return p.slice(0, end);
}

/** Whether two paths overlap: identical, one a directory parent of the other
 *  (a separator boundary, so `src` never matches `src-other`), or either
 *  repository-wide (empty). */
export function pathsOverlap(p: string, q: string): boolean {
  if (p === '' || q === '') return true;
  const a = stripTrailingSeparator(p);
  const b = stripTrailingSeparator(q);
  if (a === '' || b === '') return true;
  if (a === b) return true;
  return a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/** Whether two path LISTS overlap: an empty list is repository-wide, and a
 *  repository-wide claim overlaps every path in the repository. */
export function pathSetsOverlap(a: readonly string[], b: readonly string[]): boolean {
  if (a.length === 0 || b.length === 0) return true;
  for (const p of a) {
    for (const q of b) {
      if (pathsOverlap(p, q)) return true;
    }
  }
  return false;
}

/**
 * The pure conflict rule over path claims. Two claims conflict when they name
 * the same repository, at least one side writes, and their path sets overlap
 * (repository-wide = `[]`). read/read never conflicts, on any paths.
 */
export function claimsConflict(a: ConflictClaim, b: ConflictClaim): boolean {
  if (a.repo !== b.repo) return false;
  if (a.mode === 'read' && b.mode === 'read') return false;
  return pathSetsOverlap(a.paths, b.paths);
}

/** The conflict rule at the DERIVED-domain level: same physical domain, at
 *  least one side writes, and the domains' claimed paths overlap. This is what
 *  the scheduler compares held leases and admitted work against — it is the
 *  domain-key form of `claimsConflict`, so aliased repository entries (one
 *  worktree) serialize even though their manifest repo names differ. */
export function domainsConflict(a: ActivationDomain, b: ActivationDomain): boolean {
  if (a.physicalDomain !== b.physicalDomain) return false;
  if (a.accessMode === 'read' && b.accessMode === 'read') return false;
  return pathSetsOverlap(a.paths ?? [], b.paths ?? []);
}

/** The node shapes whose claims `activationDomainKeys` reduces. */
export type NodeClaimsShape =
  | {
      kind: 'agent';
      reads?: readonly RepoPathClaim[];
      writes?: readonly RepoPathClaim[];
    }
  | {
      kind: 'command';
      command: string;
      repositories?: readonly string[];
    };

/**
 * A node's declared claims. An agent's reads/writes become read/write claims
 * (an empty path list is NOT repo-wide for an agent — it contributes nothing,
 * matching the integration pipeline's declared-writes resolution); a command
 * node claims repository-wide per its PINNED allowlist access, and an unknown
 * command is not trusted and claims nothing.
 */
export function nodeClaimsOf(
  node: NodeClaimsShape,
  commands: AllowlistCommandAccess,
): ConflictClaim[] {
  if (node.kind === 'agent') {
    const claims: ConflictClaim[] = [];
    for (const c of node.reads ?? []) {
      if (c.paths.length > 0) claims.push({ repo: c.repo, paths: c.paths, mode: 'read' });
    }
    for (const c of node.writes ?? []) {
      if (c.paths.length > 0) claims.push({ repo: c.repo, paths: c.paths, mode: 'write' });
    }
    return claims;
  }
  const access = commands.get(node.command);
  if (!access) return [];
  return (node.repositories ?? []).map((repo) => ({ repo, paths: [], mode: access }));
}

/**
 * Reduce a node's declared claims to the ordered `ActivationDomain[]` used by
 * `acquireDomainLeases` — deduplicated by the injected physical-domain key
 * (`write` wins over `read`; claimed paths union; any repository-wide claim
 * makes the domain repository-wide) and sorted by key for determinism. A repo
 * the physical-domain map cannot resolve is dropped, never guessed.
 */
export function activationDomainKeys(
  node: NodeClaimsShape,
  commands: AllowlistCommandAccess,
  physicalDomainOf: (repo: string) => string | null,
): ActivationDomain[] {
  interface Entry {
    accessMode: AccessMode;
    paths: string[];
    repoWide: boolean;
  }
  const byDomain = new Map<string, Entry>();
  for (const claim of nodeClaimsOf(node, commands)) {
    const physicalDomain = physicalDomainOf(claim.repo);
    if (physicalDomain === null) continue;
    let entry = byDomain.get(physicalDomain);
    if (!entry) {
      entry = { accessMode: 'read', paths: [], repoWide: false };
      byDomain.set(physicalDomain, entry);
    }
    if (claim.mode === 'write') entry.accessMode = 'write';
    if (claim.paths.length === 0) {
      entry.repoWide = true;
    } else {
      for (const path of claim.paths) {
        if (!entry.paths.includes(path)) entry.paths.push(path);
      }
    }
  }
  return [...byDomain.entries()]
    .map(([physicalDomain, entry]) => ({
      physicalDomain,
      accessMode: entry.accessMode,
      paths: entry.repoWide ? [] : entry.paths.sort(),
    }))
    .sort((a, b) => (a.physicalDomain < b.physicalDomain ? -1 : a.physicalDomain > b.physicalDomain ? 1 : 0));
}

/** A held lease observed by the scheduler: the domain, its access, whether
 *  the owner's process death is unprovable (then it blocks EVERYTHING), and
 *  the claimed paths (`[]` = repository-wide). */
export interface SchedulerLease {
  physicalDomain: string;
  accessMode: AccessMode;
  ambiguous: boolean;
  paths: readonly string[];
}

/** One pending activation group the sweep asks the scheduler about. */
export interface SchedulerGroup {
  destination: string;
  nodeKind: 'agent' | 'command' | 'gate' | 'join';
  /** The derived physical domains the activation needs (write-wins dedup). */
  domains: readonly ActivationDomain[];
  /** The group's earliest token creation time (ISO). */
  created: string;
  /** The group's earliest token id — breaks one-millisecond creation ties. */
  tokenId: number;
  forkInstance: number;
  /** The full fork-lineage stack (outermost first); correlation key member
   *  (Slice 5 Task 4) — two forks sharing a visit number never collide. */
  forkLineage: string | null;
  /** A join whose arrival set is not fully pending is dependency-waiting. */
  dependencyWaiting: boolean;
}

export interface SchedulerState {
  /** Every `held`/`ambiguous-process` lease in the store, other-owner. */
  heldLeases: readonly SchedulerLease[];
  /** The graph run's durable `active_processes` counter. */
  activeProcesses: number;
  /** The manifest's `graph.limits.maxParallel` (the external-process ceiling). */
  maxParallel: number;
}

export type SchedulerRefusalReason = 'dependency-waiting' | 'resource-conflict' | 'parallel-slot-busy';

export interface SchedulerRefusal {
  reason: SchedulerRefusalReason;
  detail: string;
}

export interface SchedulerDecision {
  destination: string;
  nodeKind: SchedulerGroup['nodeKind'];
  admitted: boolean;
  refused?: SchedulerRefusal;
}

const PROCESS_KINDS: readonly SchedulerGroup['nodeKind'][] = ['agent', 'command'];

/** The conflicting held lease for a group's domains, or null. */
function heldLeaseConflict(
  domains: readonly ActivationDomain[],
  leases: readonly SchedulerLease[],
): string | null {
  for (const lease of leases) {
    for (const domain of domains) {
      if (domain.physicalDomain !== lease.physicalDomain) continue;
      if (lease.ambiguous) {
        return `physical domain ${lease.physicalDomain} has an ambiguous-process lease (process death unproven)`;
      }
      if (domain.accessMode === 'read' && lease.accessMode === 'read') continue;
      if (pathSetsOverlap(domain.paths ?? [], lease.paths)) {
        const breadth = lease.paths.length === 0 ? 'repo-wide' : lease.paths.join(',');
        return `physical domain ${lease.physicalDomain} is held ${lease.accessMode} (${breadth}) by another node run`;
      }
    }
  }
  return null;
}

/**
 * Whether two groups' derived domains conflict — the same rule held leases
 * are measured by, so work admitted in one tick never contradicts what the
 * claim's lease backstop will refuse.
 */
function groupsConflict(a: SchedulerGroup, b: SchedulerGroup): boolean {
  for (const da of a.domains) {
    for (const db of b.domains) {
      if (domainsConflict(da, db)) return true;
    }
  }
  return false;
}

/**
 * The pre-claim admission for a sweep tick, in the order the sweep presents
 * the groups (already age-sorted). Each group in turn: a dependency-waiting
 * node is refused and NOT resource-blocked; a group whose domains conflict
 * with a held lease or with already-admitted work defers with a reason; an
 * agent/command at the process ceiling defers `parallel-slot-busy`; gates and
 * joins consume no process slot. Returns one decision per input group, in
 * order — the sweep claims the admitted ones and persists a deferral for each
 * refusal, so deliberate serialization never reads as a scheduler defect.
 */
export function schedulerReady(
  groups: readonly SchedulerGroup[],
  state: SchedulerState,
): SchedulerDecision[] {
  const admitted: SchedulerGroup[] = [];
  let admittedProcesses = 0;
  const decisions: SchedulerDecision[] = [];
  for (const group of groups) {
    const refuse = (reason: SchedulerRefusalReason, detail: string): void => {
      decisions.push({
        destination: group.destination,
        nodeKind: group.nodeKind,
        admitted: false,
        refused: { reason, detail },
      });
    };
    if (group.dependencyWaiting) {
      refuse('dependency-waiting', `node ${group.destination} waits on its full arrival set`);
      continue;
    }
    const held = heldLeaseConflict(group.domains, state.heldLeases);
    if (held !== null) {
      refuse('resource-conflict', held);
      continue;
    }
    const peer = admitted.find((a) => groupsConflict(a, group));
    if (peer) {
      refuse('resource-conflict', `conflicts with already-scheduled ${peer.destination}`);
      continue;
    }
    if (
      PROCESS_KINDS.includes(group.nodeKind)
      && state.activeProcesses + admittedProcesses >= state.maxParallel
    ) {
      refuse(
        'parallel-slot-busy',
        `active process ceiling reached (maxParallel ${state.maxParallel})`,
      );
      continue;
    }
    admitted.push(group);
    if (PROCESS_KINDS.includes(group.nodeKind)) admittedProcesses += 1;
    decisions.push({ destination: group.destination, nodeKind: group.nodeKind, admitted: true });
  }
  return decisions;
}

/**
 * The deterministic ready ordering: a group whose node has waited
 * `AGING_THRESHOLD_MS` or more while ready-but-blocked is preferred over
 * newer work (oldest waiter first); everything else sorts by creation time
 * then token id. Pure — the clock and the per-node wait provenance are
 * injected, so the ordering is testable without sleeps.
 */
export function agingPriority(
  groups: readonly SchedulerGroup[],
  now: string,
  waitSinceOf: (destination: string) => string | null,
): SchedulerGroup[] {
  const nowMs = Date.parse(now);
  const agedElapsedOf = (group: SchedulerGroup): number | null => {
    const waitSince = waitSinceOf(group.destination);
    if (waitSince === null) return null;
    const elapsed = nowMs - Date.parse(waitSince);
    return elapsed >= AGING_THRESHOLD_MS ? elapsed : null;
  };
  return [...groups].sort((a, b) => {
    const aElapsed = agedElapsedOf(a);
    const bElapsed = agedElapsedOf(b);
    // Both aged: the OLDEST waiter first (largest elapsed), so a wide node
    // parked longest is the first to be preferred over newer narrow work.
    if (aElapsed !== null && bElapsed !== null) return bElapsed - aElapsed;
    if (aElapsed !== null) return -1;
    if (bElapsed !== null) return 1;
    const created = a.created.localeCompare(b.created);
    if (created !== 0) return created;
    return a.tokenId - b.tokenId;
  });
}
