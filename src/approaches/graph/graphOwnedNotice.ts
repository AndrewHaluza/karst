/**
 * What the user sees when a launch on a graph-owned ticket cannot start a new
 * session (T1138). A graph-owned Start, Restart or Open is not a launch, and a
 * silent no-op made the user try other changes with no effect. The notice names
 * the run, its status and the state of its planner or nodes, and offers the
 * one Cancel operation (`cancel.ts`) behind a modal confirm.
 *
 * Host-agnostic: the window, the process probes and the cancel are injected.
 */

import type { GraphDb } from '../../store/graph/transitions.js';
import { cancelableProcesses } from '../../store/graph/cancelRun.js';
import type { ProcessFactsSource } from '../../runtime/serverIdentity.js';
import type { CancelGraphRunResult } from './cancel.js';
import { plural } from '../../model/notifyText.js';

export const CANCEL_GRAPH_ACTION = 'Cancel graph';

/** How many planner and node processes of a run are alive by the OS's own answer. */
export interface GraphRunLiveness {
  readonly livePlanners: number;
  readonly liveNodes: number;
}

export interface GraphOwnedRun {
  readonly graphRunId: number;
  readonly status: string;
}

/** Counts the live planner and node processes from the durable `process_runs` pids. */
export async function graphRunLiveness(
  db: GraphDb,
  facts: ProcessFactsSource,
  graphRunId: number,
): Promise<GraphRunLiveness> {
  let livePlanners = 0;
  let liveNodes = 0;
  for (const proc of cancelableProcesses(db, graphRunId)) {
    if (!(await facts.isAlive(proc.pid))) continue;
    if (proc.kind === 'planner') livePlanners += 1;
    else liveNodes += 1;
  }
  return { livePlanners, liveNodes };
}

/** A run status in words for a toast; the stored slug stays out of the text. */
function statusWord(status: string): string {
  switch (status) {
    case 'draining':
      return 'stopping';
    case 'completed-awaiting-impl-marker':
      return 'finished';
    default:
      return status;
  }
}

function stateClause(status: string, liveness: GraphRunLiveness): string {
  switch (status) {
    case 'planning':
      return liveness.livePlanners > 0
        ? 'its planner is alive, but its session is not attached to this window'
        : 'its planner has no live session';
    case 'running':
    case 'draining':
      return liveness.liveNodes > 0
        ? `${plural(liveness.liveNodes, 'agent is', 'agents are')} running, but no session is attached to this window`
        : 'none of its agents has a live session';
    case 'blocked':
      return 'it is parked until you resume or cancel it';
    case 'completed-awaiting-impl-marker':
      return 'it waits for you to move the ticket on';
    default:
      return 'its coordinator owns the next step';
  }
}

/** The warning text: names the run, its status and the planner or node state. */
export function graphOwnedMessage(
  ticketLabel: string,
  run: GraphOwnedRun,
  liveness: GraphRunLiveness,
): string {
  return `${ticketLabel}: no new session started because the graph run is ${statusWord(run.status)} and ${stateClause(run.status, liveness)}. Select Cancel graph to stop it.`;
}

/** The note for an agent, model or preset change on a graph-owned ticket. */
export function graphOwnedChangeMessage(ticketLabel: string, run: GraphOwnedRun): string {
  return `${ticketLabel}: the change applies to the next launch, not to the current graph run (${statusWord(run.status)}).`;
}

export interface GraphOwnedNoticeDeps {
  readonly warn: (message: string, ...actions: string[]) => PromiseLike<string | undefined>;
  /** A modal confirm: true only on the explicit accept. */
  readonly confirm: (message: string, accept: string) => PromiseLike<boolean>;
  readonly cancel: (graphRunId: number) => Promise<CancelGraphRunResult>;
  /** Refreshes the ticket views after a cancel. */
  readonly refresh: () => void;
  readonly inform: (message: string) => void;
  readonly logError: (message: string, error: unknown) => void;
}

function cancelResultMessage(ticketLabel: string, result: CancelGraphRunResult): string {
  switch (result.outcome) {
    case 'cancelled':
      return `${ticketLabel}: the graph run is cancelled. The next Start uses the current approach of the ticket.`;
    case 'refused-live-process':
      return `${ticketLabel}: the graph run is not cancelled because a live process may not belong to it. Karst stopped no process.`;
    case 'already-terminal':
      return `${ticketLabel}: the graph run already ended.`;
    case 'raced':
      return `${ticketLabel}: the graph run changed state during the cancel. Check the ticket and try again.`;
  }
}

/**
 * Shows the warning with a "Cancel graph" action. Only the explicit accept of
 * the modal calls cancel; a dismissed warning or a declined confirm changes
 * nothing. After a cancel the ticket refreshes.
 */
export async function showGraphOwnedNotice(
  deps: GraphOwnedNoticeDeps,
  input: { ticketLabel: string; run: GraphOwnedRun; liveness: GraphRunLiveness },
): Promise<void> {
  const { ticketLabel, run } = input;
  const picked = await deps.warn(graphOwnedMessage(ticketLabel, run, input.liveness), CANCEL_GRAPH_ACTION);
  if (picked !== CANCEL_GRAPH_ACTION) return;
  const accepted = await deps.confirm(
    `Cancel the graph run of ${ticketLabel}? Its live processes stop and its work in progress ends.`,
    CANCEL_GRAPH_ACTION,
  );
  if (!accepted) return;
  try {
    const result = await deps.cancel(run.graphRunId);
    deps.refresh();
    deps.inform(cancelResultMessage(ticketLabel, result));
  } catch (error) {
    deps.logError(`graph cancel failed for run ${run.graphRunId}`, error);
  }
}
