/**
 * The change-set capture and the claim-violation facts of a node run, shared by
 * the completion pipeline (`pipeline.ts`) and the claim evidence of a `blocked`
 * node (`claimEvidence.ts`, T1323).
 *
 * Host-agnostic: the db, the git runner, the transport, the process facts and
 * the workspace lookup are injected.
 */

import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type { GitRunner } from '../../../integrations/git.js';
import type { ProcessFactsSource } from '../../../runtime/serverIdentity.js';
import { graphRunIdStatus, markGraphRunBlocked } from '../../../store/graph/graphRuns.js';
import { nodeRunBaseHeads } from '../../../store/graph/nodeRuns.js';
import { casStatus, GRAPH_RUN_TRANSITIONS, type GraphDb } from '../../../store/graph/transitions.js';
import { attributeOf, processOf } from '../coordinator/reconcile.js';
import { inReplanDrain } from '../coordinator/replanDrain.js';
import type { AgentTransport, SupervisedAgentSession } from '../transport/supervisedCliTransport.js';
import { captureChangeSet, captureUntrackedPaths, splitRegenerated, type ChangeSetEntry } from './changeSet.js';
import type { PhysicalDomain } from './domains.js';

export interface DomainCaptureDeps {
  db: GraphDb;
  debug?: (message: string) => void;
  git: GitRunner;
  /** The node's isolated workspace clone for a repo; undefined when the node
   *  has none. */
  workspaceCwdOf: (nodeRunId: number, repoName: string) => string | undefined;
}

export interface TerminationProofDeps {
  db: GraphDb;
  debug?: (message: string) => void;
  facts: ProcessFactsSource;
  transport: AgentTransport;
  /** The transport's session for a node run; undefined after a reload. */
  getSession: (nodeRunId: number) => SupervisedAgentSession | undefined;
}

/** The failure category of an out-of-claim write, and the prefix of its reasons. */
export const CLAIM_VIOLATION_CATEGORY = 'resource-claim-violated';

/** The most violating paths one claim-violation reason lists. */
const MAX_VIOLATIONS_IN_REASON = 5;

/** The most declared write claims one claim-violation reason lists. */
const MAX_DECLARED_CLAIMS_IN_REASON = 10;

export interface ClaimViolationReasons {
  /** The block reason of the graph run: the paths only. */
  runReason: string;
  /** The reason of the node run: the paths and the declared write claims. The
   *  replan planner reads it as evidence. */
  nodeReason: string;
}

export function claimViolationReasons(
  violations: readonly string[],
  declaredClaims: readonly string[],
): ClaimViolationReasons {
  const runReason = `${CLAIM_VIOLATION_CATEGORY}: ${violations.slice(0, MAX_VIOLATIONS_IN_REASON).join(', ')}`;
  const claims = [...new Set(declaredClaims)].sort().slice(0, MAX_DECLARED_CLAIMS_IN_REASON);
  return {
    runReason,
    nodeReason: `${runReason} (declared writes: ${claims.length === 0 ? 'none' : claims.join(', ')})`,
  };
}

/** Block a `running` graph run. Any other status, a drain too, is unchanged. */
export function blockGraphRun(
  deps: { db: GraphDb; transaction: <T>(fn: () => T) => T; now: () => string },
  graphRunId: number,
  reason: string,
): void {
  deps.transaction(() => {
    if (
      casStatus(
        deps.db,
        'approach_graph_runs',
        GRAPH_RUN_TRANSITIONS,
        graphRunId,
        'running',
        'blocked',
      )
    ) {
      markGraphRunBlocked(deps.db, graphRunId, reason, deps.now());
    }
  });
}

/** The run drains for a replan NOW: a node that is live in this drain completes
 *  and integrates, and it makes no successor. A Stop drain is not one. */
export function drainsForReplan(db: GraphDb, graphRunId: number): boolean {
  return graphRunIdStatus(db, graphRunId)?.status === 'draining' && inReplanDrain(db, graphRunId);
}

/** One domain's captured change set plus the workspace clones it came from. */
export interface DomainCapture {
  entries: ChangeSetEntry[];
  workspaceCwds: string[];
  /** The base the workspace diff was taken against; `null` for the canonical
   *  fallback, which diffs `HEAD`. */
  workspaceBaseRef: string | null;
}

/**
 * The node's claim-time base commit for one physical domain — the commit the
 * workspace provider checked the clone out at (`--detach`), read from the
 * `base_heads` the claim transaction recorded. Empty string when the node has
 * no recorded head for this domain.
 *
 * This is the diff base for a workspace clone. `HEAD` is NOT: an agent that
 * commits its work inside the clone moves `HEAD` onto its own commit, so
 * `git diff HEAD` reports an empty change set and the work is integrated
 * nowhere and then deleted with the clone.
 */
function workspaceBaseCommit(
  deps: Pick<DomainCaptureDeps, 'db'>,
  nodeRunId: number,
  domainKey: string,
): string {
  return nodeRunBaseHeads(deps.db, nodeRunId).find((head) => head.domainKey === domainKey)?.commit ?? '';
}

/**
 * Capture a domain's change set. Under Slice 5 Task 1 the node works in ITS
 * isolated workspace clone(s) — the diff is read from each clone (a domain
 * aliases one or more repos) and merged; only a domain for which the node has
 * NO workspace falls back to the canonical worktree (the V1 canonical model).
 */
export async function captureDomainChangeSet(
  deps: DomainCaptureDeps,
  nodeRunId: number,
  domain: PhysicalDomain,
): Promise<DomainCapture> {
  return (
    (await captureWorkspaceChangeSet(deps, nodeRunId, domain)) ??
    (await captureCanonicalChangeSet(deps, nodeRunId, domain))
  );
}

/** Capture a domain's change set from the node's workspace clones only;
 *  `undefined` when the node has none. It never touches the canonical tree. */
export async function captureWorkspaceChangeSet(
  deps: DomainCaptureDeps,
  nodeRunId: number,
  domain: PhysicalDomain,
): Promise<DomainCapture | undefined> {
  const workspaceCwds = domain.repoNames
    .map((repoName) => deps.workspaceCwdOf(nodeRunId, repoName))
    .filter((cwd): cwd is string => cwd !== undefined);
  if (workspaceCwds.length === 0) return undefined;
  // A workspace clone is checked out DETACHED at the node's recorded base
  // commit, so that commit — never `HEAD` — is the only diff base that sees
  // work the agent committed inside the clone. Without one there is no
  // trustworthy base: refuse rather than report an empty change set, which is
  // how a node's committed work was silently discarded.
  const workspaceBaseRef = workspaceBaseCommit(deps, nodeRunId, domain.key);
  if (!workspaceBaseRef) {
    throw new Error(
      `node run ${nodeRunId} has no recorded base head for domain ${domain.key} — refusing to diff its workspace clone against HEAD`,
    );
  }
  const { kept, dropped } = await changedPaths(deps, workspaceCwds, workspaceBaseRef, domain);
  // A workspace clone is discarded after integration, so nothing is restored.
  for (const entry of dropped) logDropped(deps, nodeRunId, entry);
  return { entries: kept, workspaceCwds, workspaceBaseRef };
}

/** The V1 canonical model: the node wrote straight into the canonical tree, so
 *  a dropped regenerated path is restored there. */
async function captureCanonicalChangeSet(
  deps: DomainCaptureDeps,
  nodeRunId: number,
  domain: PhysicalDomain,
): Promise<DomainCapture> {
  const { kept, dropped } = await changedPaths(deps, [domain.canonicalWorktree], 'HEAD', domain);
  for (const entry of dropped) {
    await restoreFromBase(deps, domain.canonicalWorktree, 'HEAD', entry);
    logDropped(deps, nodeRunId, entry);
  }
  return { entries: kept, workspaceCwds: [], workspaceBaseRef: null };
}

function logDropped(deps: DomainCaptureDeps, nodeRunId: number, entry: ChangeSetEntry): void {
  deps.debug?.(`[graph] node ${nodeRunId}: dropped regenerated path ${entry.path}`);
}

/** The merged changed paths of the trees, without the regenerated paths. */
async function changedPaths(
  deps: DomainCaptureDeps,
  cwds: readonly string[],
  baseRef: string,
  domain: PhysicalDomain,
): Promise<{ kept: ChangeSetEntry[]; dropped: ChangeSetEntry[] }> {
  const merged = new Map<string, ChangeSetEntry>();
  for (const cwd of cwds) {
    const entries = await captureChangeSet(deps.git, { cwd, baseRef });
    for (const entry of entries) {
      if (!merged.has(entry.path)) merged.set(entry.path, entry);
    }
    // A file a node created but never `git add`-ed is invisible to `git diff
    // --name-status` — it must still enter claim validation as an `added`
    // entry, or an out-of-claim untracked file is silently dropped rather
    // than parking the node (the defect this closes). `--exclude-standard`
    // keeps karst's own excluded scaffolding (`.karst/`, `.karst-plugin/`,
    // ...) out of both validation and reporting.
    const untracked = await captureUntrackedPaths(deps.git, cwd);
    for (const path of untracked) {
      if (!merged.has(path)) merged.set(path, { path, kind: 'added' });
    }
  }
  return splitRegenerated([...merged.values()], domain.regeneratedPaths);
}

/** Put a path back to its state at `baseRef`; a path absent there is removed. */
async function restoreFromBase(
  deps: Pick<DomainCaptureDeps, 'git'>,
  cwd: string,
  baseRef: string,
  entry: ChangeSetEntry,
): Promise<void> {
  const restored =
    entry.kind === 'added'
      ? { exitCode: 1, stderr: '' }
      : await deps.git(['restore', `--source=${baseRef}`, '--staged', '--worktree', '--', entry.path], cwd);
  if (restored.exitCode === 0) return;
  await deps.git(['rm', '-f', '--cached', '--ignore-unmatch', '--', entry.path], cwd);
  rmSync(join(cwd, entry.path), { recursive: true, force: true });
}

/** Terminate the node's process and require positive evidence of its end. */
export async function terminationProven(
  deps: TerminationProofDeps,
  node: { id: number; process_run_id: number | null },
): Promise<boolean> {
  const session = deps.getSession(node.id);
  if (!session) {
    const proc = processOf(deps.db, node);
    if (!proc) {
      deps.debug?.(
        `[graph] node ${node.id}: no session in the registry and no durable process identity — cannot prove termination`,
      );
      return false;
    }
    const attribution = await attributeOf(deps.facts, proc);
    const proven = attribution === 'dead' || attribution === 'foreign';
    if (!proven) {
      deps.debug?.(
        `[graph] node ${node.id}: termination not proven from durable OS facts (${attribution})`,
      );
    }
    return proven;
  }
  const proof = await deps.transport.terminate(session);
  const proven =
    (proof.kind === 'attributable' && proof.kill === 'killed') || proof.kind === 'dead';
  if (!proven) {
    deps.debug?.(
      `[graph] node ${node.id}: termination not proven (${proof.kind}${proof.kind === 'attributable' ? `:${proof.kill}` : ''})`,
    );
  }
  return proven;
}
