/**
 * Graph recovery (Slice 3 Task 9, recovery row).
 *
 * The typed `graph-recovery` action resolves here. Recovery is graph-aware
 * and atomic: in ONE `BEGIN IMMEDIATE` transaction it CAS-claims the BLOCKED
 * graph run, resolves the failure category from the persisted `blocked_reason`
 * (the earliest failure by durable event order), and moves every blocked node
 * run `blocked → launching` — a LAUNCH RETRY that reuses the reserved visit.
 * The token stays claimed (there is deliberately no `claimed → pending`
 * transition) and the prompt is NOT re-snapshotted: a retry is a retry.
 * Only after the retry has durably entered that recoverable state is the
 * visible `approach-graph-failed` stage block cleared. This never synthesizes
 * node success, chooses a fallback provider, or advances the stage.
 *
 * `termination-unknown` is never auto-retried: the user must discard the
 * unknown process (Slice 4). Replan/expert diagnosis — a new revision from a
 * planner run — is the Slice-4 recovery tier; V1 retries on the same revision.
 *
 * Host-agnostic: store + transaction + clock injected.
 */

import type { Store } from '../../../store/db.js';
import { clearStageBlock, stageBlock } from '../../../store/stageBlocks.js';
import { getTicket } from '../../../store/tickets.js';
import { casStatus, GRAPH_RUN_TRANSITIONS, NODE_RUN_TRANSITIONS } from '../../../store/graph/transitions.js';

/** The one graph blocker kind (defined here, on the graph side; the stage
 *  boundary module and the model's `BlockerKind` refer to this string). */
export const GRAPH_FAILED_BLOCKER = 'approach-graph-failed' as const;

export interface RecoveryDeps {
  store: Store;
  /** BEGIN IMMEDIATE-wrapped, all-or-nothing; a throw rolls back. */
  transaction: <T>(fn: () => T) => T;
  now: () => string;
  debug?: (message: string) => void;
}

export type RecoveryResult =
  | { kind: 'retried'; retried: number[] }
  | { kind: 'refused'; reason: string }
  | { kind: 'no-op' };

/** Categories that may retry on the same revision; `termination-unknown`
 *  never retries itself — the user must discard the unknown process. */
function retryableCategory(reason: string | null): boolean {
  if (!reason) return false;
  if (reason.includes('termination-unknown')) return false;
  return (
    reason.includes('resource-claim-violated') ||
    reason.includes('integration-conflict') ||
    reason.includes('node-blocked')
  );
}

/**
 * Claim and run graph recovery for one blocked run. Returns what happened;
 * `refused` names the category that must not retry itself.
 */
export function recoverGraphRun(
  deps: RecoveryDeps,
  input: { ticketId: number; graphRunId: number },
): RecoveryResult {
  const { store } = deps;
  const ticket = getTicket(store, input.ticketId);
  if (ticket.stageCurrent !== 'impl') return { kind: 'no-op' };

  return deps.transaction(() => {
    const run = store.db
      .prepare('SELECT id, status, blocked_reason FROM approach_graph_runs WHERE id = ?')
      .get(input.graphRunId) as { id: number; status: string; blocked_reason: string | null } | undefined;
    if (!run || run.status !== 'blocked') return { kind: 'no-op' };

    if (!retryableCategory(run.blocked_reason)) {
      deps.debug?.(`[graph] recovery refused for run ${input.graphRunId}: ${run.blocked_reason ?? 'unknown reason'}`);
      return { kind: 'refused', reason: run.blocked_reason ?? 'unknown failure category' };
    }

    // Retry: the graph run re-opens and every blocked node run re-launches.
    // The block's reason is cleared with the transition — the retry's failure
    // will re-block with a fresh, earliest reason.
    if (
      !casStatus(
        store.db,
        'approach_graph_runs',
        GRAPH_RUN_TRANSITIONS,
        input.graphRunId,
        'blocked',
        'running',
      )
    ) {
      return { kind: 'no-op' }; // a racing window claimed it
    }
    store.db
      .prepare('UPDATE approach_graph_runs SET blocked_reason = NULL, updated_at = ? WHERE id = ?')
      .run(deps.now(), input.graphRunId);

    const blockedNodes = store.db
      .prepare(
        `SELECT id FROM approach_node_runs
         WHERE graph_run_id = ? AND status = 'blocked'
         ORDER BY id`,
      )
      .all(input.graphRunId) as { id: number }[];
    const retried: number[] = [];
    for (const node of blockedNodes) {
      if (casStatus(store.db, 'approach_node_runs', NODE_RUN_TRANSITIONS, node.id, 'blocked', 'launching')) {
        retried.push(node.id);
      }
    }

    // The stage block clears only now, INSIDE the same transaction: the retry
    // has durably entered a recoverable state.
    const block = stageBlock(store, input.ticketId, 'impl');
    if (block && block.kind === GRAPH_FAILED_BLOCKER) {
      clearStageBlock(store, input.ticketId, 'impl');
    }
    deps.debug?.(
      `[graph] recovery: run ${input.graphRunId} retried (${retried.join(',') || 'none'}) — stage block cleared`,
    );
    return { kind: 'retried', retried };
  });
}
