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

function stateClause(status: string, liveness: GraphRunLiveness): string {
  switch (status) {
    case 'planning':
      return liveness.livePlanners > 0
        ? 'its planner is alive, but its session is not attached to this window'
        : 'its planner has no live session';
    case 'running':
    case 'draining':
      return liveness.liveNodes > 0
        ? `${liveness.liveNodes} node process${liveness.liveNodes === 1 ? ' is' : 'es are'} alive, but no session is attached to this window`
        : 'none of its nodes has a live session';
    case 'blocked':
      return 'it is parked until you resume or cancel it';
    case 'completed-awaiting-impl-marker':
      return 'it waits for the implementation marker';
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
  return `Ticket ${ticketLabel}: graph run ${run.graphRunId} is ${run.status}; ${stateClause(run.status, liveness)}. No new session started.`;
}

/** The note for an agent, model or preset change on a graph-owned ticket. */
export function graphOwnedChangeMessage(ticketLabel: string, run: GraphOwnedRun): string {
  return `Ticket ${ticketLabel}: the change applies to the next launch, not to graph run ${run.graphRunId} (${run.status}).`;
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
      return `Ticket ${ticketLabel}: graph run ${result.graphRunId} was cancelled. The next Start uses the ticket's current approach.`;
    case 'refused-live-process':
      return `Ticket ${ticketLabel}: graph run ${result.graphRunId} was NOT cancelled — a live process could not be proven to belong to it, so none was stopped.`;
    case 'already-terminal':
      return `Ticket ${ticketLabel}: graph run ${result.graphRunId} already ended (${result.status ?? 'unknown'}).`;
    case 'raced':
      return `Ticket ${ticketLabel}: graph run ${result.graphRunId} changed state while it was cancelled — check the ticket and try again.`;
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
    `Cancel graph run ${run.graphRunId} (${run.status}) of ticket ${ticketLabel}? Its live processes stop and its work in progress ends.`,
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
