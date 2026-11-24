/**
 * Claim evidence for a node that reported `blocked` (T1323).
 *
 * The completion pipeline checks the declared writes of a node that reported
 * `complete`. A node that reported `blocked` never enters it, so its out-of-claim
 * work gave no evidence and the recovery retried the same claims. This step runs
 * the same check on that node's workspace clone. A violation classifies the node
 * as `resource-claim-violated` and blocks the run on it, which routes a replan.
 *
 * The agent's report routes nothing (Decision 27): only the host's own capture
 * does. Termination is proven first, because the replan drain treats the
 * category as proof that no process lives. The canonical tree is never read: a
 * domain without a clone on disk is skipped.
 *
 * The work is preserved only on a violation. A node in a replan drain is
 * evaluated again on each tick until its drain cancel, which preserves the work.
 */

import { existsSync } from 'node:fs';
import {
  blockedNodeRunsWithoutCategory,
  nodeRunSessionIdentity,
  nodeRunTicketId,
  setNodeRunFailure,
  type UnclassifiedBlockedNodeRun,
} from '../../../store/graph/nodeRuns.js';
import { graphRunIdStatus } from '../../../store/graph/graphRuns.js';
import { plannerRunTicketId } from '../../../store/graph/plannerRuns.js';
import { emitGraphDiagnostic } from '../diagnostics.js';
import { preserveBestEffort } from '../workspace/preserveBestEffort.js';
import { validateChangeSet } from './changeSet.js';
import {
  blockGraphRun,
  captureWorkspaceChangeSet,
  CLAIM_VIOLATION_CATEGORY,
  claimViolationReasons,
  drainsForReplan,
  terminationProven,
} from './changeSetCapture.js';
import { resolvePhysicalDomains } from './domains.js';
import type { CompletionPipelineDeps } from './pipeline.js';

export type ClaimEvidenceDeps = Pick<
  CompletionPipelineDeps,
  | 'db'
  | 'transaction'
  | 'now'
  | 'debug'
  | 'facts'
  | 'git'
  | 'gitCommonDirOf'
  | 'transport'
  | 'getSession'
  | 'domainsFor'
  | 'declaredWritesOf'
  | 'workspaceCwdOf'
  | 'preserveWork'
>;

/** One node run that this call classified as `resource-claim-violated`. */
export interface ClaimEvidence {
  nodeRunId: number;
  violations: string[];
}

/**
 * Classify each `blocked` node run whose workspace holds an out-of-claim path.
 * Run it before each settle of the graph run. A node run that cannot be
 * evaluated is logged and left unchanged; the other node runs are evaluated.
 */
export async function recordClaimEvidence(
  deps: ClaimEvidenceDeps,
  graphRunId: number,
): Promise<ClaimEvidence[]> {
  if (!evidenceApplies(deps, graphRunId)) return [];
  const evidence: ClaimEvidence[] = [];
  const evaluated = new Set<number>();
  const nextNode = (): UnclassifiedBlockedNodeRun | undefined =>
    blockedNodeRunsWithoutCategory(deps.db, graphRunId).find((row) => !evaluated.has(row.id));
  // Read the list again after each node: a node that reports `blocked` during an
  // evaluation must not reach the settle without its own evaluation.
  for (let node = nextNode(); node !== undefined; node = nextNode()) {
    evaluated.add(node.id);
    const violations = await violationsOf(deps, node);
    if (violations.length === 0) continue;
    await preserveBestEffort(deps, node.id, 'claim evidence');
    if (classify(deps, graphRunId, node.id, violations)) evidence.push({ nodeRunId: node.id, violations });
  }
  return evidence;
}

/** The run is `running`, or it drains for a replan. A Stop drain is neither. */
function evidenceApplies(deps: Pick<ClaimEvidenceDeps, 'db'>, graphRunId: number): boolean {
  return graphRunIdStatus(deps.db, graphRunId)?.status === 'running' || drainsForReplan(deps.db, graphRunId);
}

/** The out-of-claim paths in the node's clones; empty when none can be proven. */
async function violationsOf(deps: ClaimEvidenceDeps, node: UnclassifiedBlockedNodeRun): Promise<string[]> {
  try {
    if (!(await terminationProven({ ...deps, getSession: (id) => unambiguousSession(deps, id) }, node))) return [];
    const onDisk: ClaimEvidenceDeps = {
      ...deps,
      workspaceCwdOf: (nodeRunId, repoName) => {
        const cwd = deps.workspaceCwdOf(nodeRunId, repoName);
        return cwd !== undefined && existsSync(cwd) ? cwd : undefined;
      },
    };
    const declared = new Map(deps.declaredWritesOf(node.id).map((d) => [d.domainKey, d.paths]));
    const violations: string[] = [];
    for (const domain of resolvePhysicalDomains(deps.domainsFor(), deps.gitCommonDirOf)) {
      const capture = await captureWorkspaceChangeSet(onDisk, node.id, domain);
      if (!capture) continue;
      const validation = validateChangeSet(declared.get(domain.key) ?? [], capture.entries);
      if (!validation.ok) violations.push(...validation.violations);
    }
    return violations;
  } catch (error) {
    deps.debug?.(`[graph] claim evidence: node run ${node.id} was not evaluated: ${String(error)}`);
    return [];
  }
}

/** The session registry key is `ticket:id`, so a planner run with the same id is
 *  ambiguous. The owner nonce of the launch then tells the two sessions apart. A
 *  session that is not the node's own is not used: the durable facts decide. */
function unambiguousSession(
  deps: ClaimEvidenceDeps,
  nodeRunId: number,
): ReturnType<ClaimEvidenceDeps['getSession']> {
  const session = deps.getSession(nodeRunId);
  const plannerTicketId = plannerRunTicketId(deps.db, nodeRunId);
  if (plannerTicketId === undefined || plannerTicketId !== nodeRunTicketId(deps.db, nodeRunId)) return session;
  const ownerNonce = nodeRunSessionIdentity(deps.db, nodeRunId)?.owner_nonce;
  return ownerNonce && session?.ownerNonce === ownerNonce ? session : undefined;
}

/** Write the category and block the run in ONE transaction, after the node and
 *  the run are checked again: both can move during the capture. */
function classify(
  deps: ClaimEvidenceDeps,
  graphRunId: number,
  nodeRunId: number,
  violations: readonly string[],
): boolean {
  const declaredClaims = deps.declaredWritesOf(nodeRunId).flatMap((d) => d.paths);
  const { runReason, nodeReason } = claimViolationReasons(violations, declaredClaims);
  const written = deps.transaction(() => {
    const unchanged =
      evidenceApplies(deps, graphRunId) &&
      blockedNodeRunsWithoutCategory(deps.db, graphRunId).some((row) => row.id === nodeRunId);
    if (!unchanged) return false;
    setNodeRunFailure(deps.db, nodeRunId, {
      failureCategory: CLAIM_VIOLATION_CATEGORY,
      reason: nodeReason,
      now: deps.now(),
    });
    // The inner transaction is a pass-through: this call already runs in one.
    blockGraphRun({ ...deps, transaction: <T>(fn: () => T): T => fn() }, graphRunId, runReason);
    return true;
  });
  if (written) {
    emitGraphDiagnostic({ db: deps.db, debug: deps.debug }, {
      category: 'completion-rejection',
      graphRunId,
      nodeRunId,
      detail: runReason,
    });
  }
  return written;
}
