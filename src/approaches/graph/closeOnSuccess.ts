/**
 * Close a graph terminal tab after a PROVEN success (T1175). Vscode-free: the
 * host injects the transport and the debug callback (@arch:DBG-01).
 *
 * - A node tab closes when `runCompletionPipeline` returns `integrated`
 *   (termination is already proven at that point).
 * - A planner tab closes when its plan or replan is `accepted` AND the
 *   planner process is proven ended.
 * Every other outcome keeps the tab open, so the person can read why.
 */

import type { SupervisedAgentSession, TerminationProof } from './transport/agentTransport.js';
import type { CompletionPipelineResult } from './integration/pipeline.js';

/** The transport methods that this module uses. */
export interface CloseOnSuccessTransport {
  sessionFor(ticketId: number, runId: number): SupervisedAgentSession | undefined;
  terminate(session: SupervisedAgentSession): Promise<TerminationProof>;
  disposeOnSuccess(session: SupervisedAgentSession): void;
}

export interface CloseOnSuccessDeps {
  transport: CloseOnSuccessTransport;
  debug: (message: string) => void;
}

/** Dispose the node session tab when the pipeline integrated the node. */
export function closeNodeTabOnSuccess(
  deps: CloseOnSuccessDeps,
  input: { ticketId: number; nodeRunId: number; sharesIdWithPlannerRun?: boolean },
  result: CompletionPipelineResult,
): boolean {
  if (result.kind !== 'integrated') return false;
  const session = deps.transport.sessionFor(input.ticketId, input.nodeRunId);
  if (!session) return false;
  // The registry key `ticket:id` cannot tell a node session from a live
  // planner session with the same id: disposing could kill the planner tab.
  if (input.sharesIdWithPlannerRun) {
    deps.debug(
      `[graph] node ${input.nodeRunId}: a planner run has the same id — the session is ambiguous, terminal tab left open`,
    );
    return false;
  }
  deps.transport.disposeOnSuccess(session);
  deps.debug(`[graph] node ${input.nodeRunId}: integrated — terminal tab closed`);
  return true;
}

/** The part of an accept result that this module reads. */
export interface PlanAcceptOutcome {
  kind: string;
}

export interface PlannerTabInput {
  ticketId: number;
  /** The planner run that the accepted plan came from; undefined when unknown. */
  plannerRunId: number | undefined;
  /** True when a node run of this ticket has the same id: the registry key
   *  `ticket:id` cannot tell the two sessions apart. */
  sharesIdWithNodeRun: boolean;
}

/** Terminate the accepted planner process, then dispose its tab. The tab stays
 *  open unless the process is proven ended. */
export async function closePlannerTabOnAccepted(
  deps: CloseOnSuccessDeps,
  input: PlannerTabInput,
  outcome: PlanAcceptOutcome,
): Promise<boolean> {
  if (outcome.kind !== 'accepted') return false;
  const { plannerRunId } = input;
  if (plannerRunId === undefined) {
    deps.debug('[graph] accepted plan: no accepted planner run found — terminal tab left open');
    return false;
  }
  const session = deps.transport.sessionFor(input.ticketId, plannerRunId);
  // No session: a later tick repeats `accepted`, or the tab is already gone.
  if (!session) return false;
  if (input.sharesIdWithNodeRun) {
    deps.debug(
      `[graph] planner ${plannerRunId}: a node run has the same id — the session is ambiguous, terminal tab left open`,
    );
    return false;
  }
  let proof: TerminationProof;
  try {
    proof = await deps.transport.terminate(session);
  } catch (error) {
    deps.debug(`[graph] planner ${plannerRunId}: terminating the process failed (${String(error)}) — terminal tab left open`);
    return false;
  }
  const proven = proof.kind === 'dead' || (proof.kind === 'attributable' && proof.kill === 'killed');
  if (!proven) {
    deps.debug(
      `[graph] planner ${plannerRunId}: process end not proven (${proof.kind}${proof.kind === 'attributable' ? `, kill ${proof.kill}` : ''}) — terminal tab left open`,
    );
    return false;
  }
  deps.transport.disposeOnSuccess(session);
  deps.debug(`[graph] planner ${plannerRunId}: plan accepted — terminal tab closed`);
  return true;
}
