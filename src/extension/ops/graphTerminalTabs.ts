/**
 * Host binding logic for the graph terminal tabs (T1175): the tab name that
 * tells a planner and each node apart, and the close of a tab after a proven
 * success. vscode-free; `extension.ts` only wires it (ratchet).
 */

import type { GraphDb } from '../../store/graph/transitions.js';
import { nodeRunNamingFacts, nodeRunTicketId } from '../../store/graph/nodeRuns.js';
import {
  acceptedBootstrapPlannerRunId,
  acceptedReplanPlannerRunId,
  plannerRunLaunchAttempt,
  plannerRunTicketId,
} from '../../store/graph/plannerRuns.js';
import { graphSessionTerminalName } from '../../approaches/graph/sessionNaming.js';
import {
  closeNodeTabOnSuccess,
  stopNodeProcessOnBlocked,
  closePlannerTabOnAccepted,
  type CloseOnSuccessTransport,
} from '../../approaches/graph/closeOnSuccess.js';
import type { CompletionPipelineResult } from '../../approaches/graph/integration/pipeline.js';

export interface GraphTabNamingDeps {
  db: () => GraphDb | undefined;
  /** The ticket's terminal name for a graph run. Throws when the run is gone. */
  ticketNameOf: (graphRunId: number) => string;
  debug: (message: string) => void;
}

/** The node id and the launch attempt of a run. Empty when the store cannot say. */
function runFacts(
  deps: GraphTabNamingDeps,
  runId: number,
  kind: 'planner' | 'node',
): { nodeId?: string; launchAttempt?: number } {
  const db = deps.db();
  if (!db) return {};
  try {
    if (kind === 'planner') return { launchAttempt: plannerRunLaunchAttempt(db, runId) };
    const facts = nodeRunNamingFacts(db, runId);
    return { nodeId: facts?.node_id, launchAttempt: facts?.launch_attempt };
  } catch (error) {
    // Keep the role suffix without the node id or the attempt.
    deps.debug(`graph session naming: run facts unreadable: ${String(error)}`);
    return {};
  }
}

/** The terminal name of a graph session: `<ticket> · planner` or
 *  `<ticket> · <node id>`. Falls back to `Karst <kind> <runId>` when the
 *  ticket is gone, so a naming failure never throws out of a terminal creation. */
export function graphSessionNameOf(
  deps: GraphTabNamingDeps,
  graphRunId: number,
  runId: number,
  kind: 'planner' | 'node',
): string {
  let ticketName: string;
  try {
    ticketName = deps.ticketNameOf(graphRunId);
  } catch (error) {
    deps.debug(`graph session naming: the ticket is unreadable (${String(error)})`);
    return `Karst ${kind} ${runId}`;
  }
  const facts = runFacts(deps, runId, kind);
  return graphSessionTerminalName({ ticketName, kind, runId, ...facts });
}

export interface GraphTabCloseDeps {
  db: () => GraphDb | undefined;
  transport: () => CloseOnSuccessTransport | undefined;
  ticketIdOf: (graphRunId: number) => number;
  debug: (message: string) => void;
  logError: (message: string, error: unknown) => void;
}

export interface GraphTabClosers {
  /** After the completion pipeline of a node: only `integrated` closes the tab. */
  node(graphRunId: number, nodeRunId: number, result: CompletionPipelineResult): void;
  /** After a node reported `block` or `replan`: stop its process, keep its tab. */
  blockedNode(graphRunId: number, nodeRunId: number): void;
  /** After an accepted bootstrap plan: terminate the planner, then close its tab. */
  bootstrapPlanner(graphRunId: number): void;
  /** After an accepted replan (the revision it produced): same as above. */
  replanPlanner(graphRunId: number, revisionNumber: number): void;
}

export function createGraphTabClosers(deps: GraphTabCloseDeps): GraphTabClosers {
  const planner = (graphRunId: number, find: (db: GraphDb) => number | undefined): void => {
    const db = deps.db();
    const transport = deps.transport();
    if (!db || !transport) return;
    const ticketId = deps.ticketIdOf(graphRunId);
    const plannerRunId = find(db);
    void closePlannerTabOnAccepted(
      { transport, debug: deps.debug },
      {
        ticketId,
        plannerRunId,
        // The registry key is `ticket:id`; a node run with this id is ambiguous.
        sharesIdWithNodeRun: plannerRunId !== undefined && nodeRunTicketId(db, plannerRunId) === ticketId,
      },
      { kind: 'accepted' },
    ).catch((error) => deps.logError(`karst: closing the planner terminal of graph run ${graphRunId} failed`, error));
  };
  // A session whose process end is proven needs no second stop. Resume reuses the
  // node run id but opens a new session, so the memo keys on the session object.
  const stopped = new WeakSet<object>();
  return {
    blockedNode: (graphRunId, nodeRunId) => {
      const transport = deps.transport();
      const db = deps.db();
      if (!transport || !db) return;
      const ticketId = deps.ticketIdOf(graphRunId);
      let session: object | undefined;
      try {
        session = transport.sessionFor(ticketId, nodeRunId);
      } catch (error) {
        deps.logError(`karst: stopping the blocked node ${nodeRunId} process failed`, error);
        return;
      }
      if (!session || stopped.has(session)) return;
      void stopNodeProcessOnBlocked(
        { transport, debug: deps.debug },
        { ticketId, nodeRunId, sharesIdWithPlannerRun: plannerRunTicketId(db, nodeRunId) === ticketId },
      )
        .then((proven) => {
          if (proven) stopped.add(session);
        })
        .catch((error) => deps.logError(`karst: stopping the blocked node ${nodeRunId} process failed`, error));
    },
    node: (graphRunId, nodeRunId, result) => {
      const transport = deps.transport();
      if (!transport) return;
      const ticketId = deps.ticketIdOf(graphRunId);
      const db = deps.db();
      closeNodeTabOnSuccess(
        { transport, debug: deps.debug },
        {
          ticketId,
          nodeRunId,
          // The registry key is `ticket:id`; a planner run with this id is ambiguous.
          // No db: the store cannot rule it out, so keep the tab open.
          sharesIdWithPlannerRun: !db || plannerRunTicketId(db, nodeRunId) === ticketId,
        },
        result,
      );
    },
    bootstrapPlanner: (graphRunId) => planner(graphRunId, (db) => acceptedBootstrapPlannerRunId(db, graphRunId)),
    replanPlanner: (graphRunId, revisionNumber) =>
      planner(graphRunId, (db) => acceptedReplanPlannerRunId(db, graphRunId, revisionNumber)),
  };
}
