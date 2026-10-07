/**
 * Cancelling an abandoned node run — the shared cleanup used by the reconcile
 * self-heal/drain repair and by the replan submit that supersedes a revision.
 *
 * A bare status flip is not enough: the row's claimed tokens, its resource
 * leases and its process slot, and its reserved node/expert budget all belong to
 * the abandoned visit and must be released with it — exactly what
 * `discardUnknownProcess` does. Leaving a `held` lease (leases select by status
 * alone, with no join to the owner's status) makes the replan's N+1 scheduler
 * read the domain as held forever; leaving `node_run_count` elevated makes a
 * near-ceiling graph refuse the replacement work.
 */

import type { GraphDb } from '../../../store/graph/transitions.js';
import { casStatus, NODE_RUN_TRANSITIONS } from '../../../store/graph/transitions.js';
import { cancelGraphToken } from '../../../store/graph/tokens.js';
import { releaseLeaseForNodeRun } from './leases.js';
import { releaseProcessSlot, setNodeRunEndedAt } from '../../../store/graph/nodeRuns.js';
import {
  decrementExpertRunCount,
  decrementNodeRunCount,
} from '../../../store/graph/graphRuns.js';
import { parseGraphDocument } from '../parse.js';

export interface AbandonedNodeRun {
  id: number;
  status: string;
  nodeKind: string;
  revisionId: number;
  nodeId: string;
}

/** Whether the claim reserved the expert budget: an agent node whose PINNED
 *  declared profile is `expert` (the same rule `discard` and the sweep use). */
function runReservedExpert(db: GraphDb, node: AbandonedNodeRun): boolean {
  if (node.nodeKind !== 'agent') return false;
  const revision = db
    .prepare('SELECT canonical_graph FROM approach_graph_revisions WHERE id = ?')
    .get(node.revisionId) as { canonical_graph: string } | undefined;
  if (!revision) return false;
  const parsed = parseGraphDocument(revision.canonical_graph);
  if (!parsed.ok) return false;
  const pinned = parsed.document.nodes.find((n) => n.id === node.nodeId);
  return pinned?.kind === 'agent' && pinned.profile === 'expert';
}

/**
 * Cancel each node run and release its tokens, leases, process slot and reserved
 * budget. MUST run inside a transaction. Returns the number of node-run
 * transitions (a row another window already moved is skipped, with no cleanup).
 */
export function cancelNodeRuns(
  deps: { db: GraphDb; now: () => string },
  graphRunId: number,
  nodes: readonly AbandonedNodeRun[],
): number {
  let cancelled = 0;
  for (const node of nodes) {
    if (
      !casStatus(deps.db, 'approach_node_runs', NODE_RUN_TRANSITIONS, node.id, node.status, 'cancelled')
    ) {
      continue; // another window moved it — no cleanup for a row we did not cancel
    }
    cancelled += 1;
    setNodeRunEndedAt(deps.db, node.id, deps.now());
    const claimed = deps.db
      .prepare(
        "SELECT id FROM approach_graph_tokens WHERE claiming_node_run_id = ? AND status = 'claimed'",
      )
      .all(node.id) as { id: number }[];
    for (const token of claimed) cancelGraphToken(deps.db, token.id);
    decrementNodeRunCount(deps.db, graphRunId, deps.now());
    if (runReservedExpert(deps.db, node)) {
      decrementExpertRunCount(deps.db, graphRunId, deps.now());
    }
    releaseLeaseForNodeRun(deps.db, node.id, { allowAmbiguous: true });
    releaseProcessSlot(deps.db, graphRunId);
  }
  return cancelled;
}
