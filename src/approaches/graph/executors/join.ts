/**
 * Join node executor (Slice 3 Task 4).
 *
 * Scheduler logic, zero tokens. The join FIRING — the all-or-nothing claim of
 * every correlated arrival with the same fork instance plus the successor
 * token insertion — already happened in the claim transaction
 * (`coordinator/claim.ts`); the join's work is nothing, so the visit created
 * at firing completes directly: `ready → completing → integrating →
 * completed`, consuming the claimed arrivals in the same transaction.
 *
 * Every logical visit — including zero-token join visits — counts toward
 * `maxNodeRuns` and the node's `maxVisits` (the claim transaction already
 * created the visit and reserved the budgets).
 *
 * Host-agnostic: db, transaction and clock are injected.
 */

import type { GraphDb } from '../../../store/graph/transitions.js';
import { consumeGraphToken } from '../../../store/graph/tokens.js';
import { NODE_RUN_TRANSITIONS, casStatus } from '../../../store/graph/transitions.js';

export interface JoinRunDeps {
  db: GraphDb;
  /** BEGIN IMMEDIATE-wrapped, all-or-nothing; a throw rolls back. */
  transaction: <T>(fn: () => T) => T;
  now: () => string;
}

/**
 * Complete a fired join: consume every claimed arrival and move the join
 * visit `ready → completing → integrating → completed` in one transaction.
 * Returns false when the run already moved (a raced completion).
 */
export function runJoinNode(
  deps: JoinRunDeps,
  input: { nodeRunId: number; arrivalTokenIds: readonly number[] },
): boolean {
  return deps.transaction(() => {
    const db = deps.db;
    // A join never launches: its ready visit completes directly (the one
    // launch-free edge in the node-run map).
    if (!casStatus(db, 'approach_node_runs', NODE_RUN_TRANSITIONS, input.nodeRunId, 'ready', 'completing')) {
      return false;
    }
    casStatus(db, 'approach_node_runs', NODE_RUN_TRANSITIONS, input.nodeRunId, 'completing', 'integrating');
    casStatus(db, 'approach_node_runs', NODE_RUN_TRANSITIONS, input.nodeRunId, 'integrating', 'completed');
    for (const tokenId of input.arrivalTokenIds) {
      consumeGraphToken(db, tokenId, input.nodeRunId, deps.now());
    }
    return true;
  });
}
