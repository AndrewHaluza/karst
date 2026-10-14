/**
 * Which run table a supervised launch's `nodeRunId` names (T693).
 *
 * A NODE launch passes its node-run id; a PLANNER launch passes its planner-run
 * id — and the two tables have independent id sequences. An ambiguous lookup
 * (try the node table, fall back to the planner table) therefore attributes a
 * planner's process to an UNRELATED node run that merely shares the number: the
 * `process_runs` row is mislabelled AND the link (`setNodeRunProcessRunId`)
 * lands on the wrong node. The request's own `runKind` is the sound
 * discriminator, so this resolves it once, host-side, where the store lives.
 */

import { nodeRunModelIdentity } from '../../store/graph/nodeRuns.js';
import { plannerRunModelIdentity } from '../../store/graph/plannerRuns.js';
import type { GraphDb } from '../../store/graph/transitions.js';
import type { AgentNodeLaunch } from '../../approaches/graph/transport/agentTransport.js';

export interface GraphLaunchIdentity {
  kind: 'node' | 'planner';
  identity: {
    id: number;
    profile: string | null;
    provider: string | null;
    model: string | null;
  };
}

export function graphLaunchIdentity(
  db: GraphDb,
  request: Pick<AgentNodeLaunch, 'nodeRunId' | 'runKind'>,
): GraphLaunchIdentity | undefined {
  if (request.runKind === 'planner') {
    const planner = plannerRunModelIdentity(db, request.nodeRunId);
    return planner === undefined ? undefined : { kind: 'planner', identity: planner };
  }
  const node = nodeRunModelIdentity(db, request.nodeRunId);
  return node === undefined ? undefined : { kind: 'node', identity: node };
}
