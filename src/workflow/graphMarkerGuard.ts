/**
 * Graph/stage boundary — the ONLY graph-aware stage surface (Slice 3 Task 9).
 *
 * Exactly three surfaces live here:
 *
 *  1. the guarded IMPL marker (`graphImplMarkerGuard`) — the only way a graph
 *     ticket's `impl` passes. In the SAME transaction as the machine's
 *     `transition`, it re-checks the current project/ticket/stage attempt,
 *     requires exactly one active graph run at `completed-awaiting-impl-marker`,
 *     re-reads every END-quiescence condition, and marks the graph run
 *     `closed`. Any earlier marker is rejected WITHOUT mutation. The graph
 *     status is an ENTRY CONDITION, never a verdict: the scheduler never
 *     writes or infers `passed`.
 *
 *  2. the `approach-graph-failed` stage-block write (`blockGraphStage`) — the
 *     block lands through `store/stageBlocks.ts` infrastructure, keyed to the
 *     ticket's CURRENT `impl` stage, and is written only while the ticket is
 *     still at `impl`.
 *
 *  3. the typed recovery action (`ResumeResult`'s `graph-recovery`) — defined
 *     here; `stageResume` only RECOGNIZES the blocker kind it may not clear
 *     and returns the typed action, holding no graph logic.
 *
 * Boundary pins (import-graph test): no graph module imports the workflow
 * machine, and no `src/workflow/` module other than `stageResume` references
 * this one.
 */

import type { Store } from '../store/db.js';
import { getTicket } from '../store/tickets.js';
import { transition } from './machine.js';
import { parkGateStage } from '../store/stageBlocks.js';
import { stageAttempt } from '../store/stages.js';
import { casStatus, GRAPH_RUN_TRANSITIONS } from '../store/graph/transitions.js';
import { quiescenceBlockedBy } from '../approaches/graph/coordinator/completion.js';
import { GRAPH_FAILED_BLOCKER } from '../approaches/graph/coordinator/recovery.js';

export { GRAPH_FAILED_BLOCKER };

export interface GraphMarkerGuardResult {
  ok: boolean;
  graphRunId?: number;
  reason?: string;
}

interface GraphRunRow {
  id: number;
  status: string;
  blocked_reason: string | null;
}

/** The ticket's graph run for a (ticket, stage attempt) pair, if any. */
function graphRunFor(
  store: Store,
  ticketId: number,
  stageAttempt: number,
): GraphRunRow | undefined {
  return store.db
    .prepare(
      `SELECT id, status, blocked_reason FROM approach_graph_runs
       WHERE ticket_id = ? AND stage_attempt = ?`,
    )
    .get(ticketId, stageAttempt) as GraphRunRow | undefined;
}

/**
 * The guarded IMPL marker: `stage impl pass` for a graph ticket, closed once.
 * Everything — the attempt checks, the quiescence re-read, the graph-close —
 * runs inside the machine transition's own transaction via `premutate`, so a
 * concurrent window's committed successors reject the marker instead of
 * racing it, and the graph-close commits with the stage advance or not at all.
 * The stage attempt is derived from the CURRENT impl stage: a graph run of an
 * older attempt can never be closed by a later marker.
 */
export function graphImplMarkerGuard(store: Store, ticketId: number): GraphMarkerGuardResult {
  const attempt = stageAttempt(store, ticketId, 'impl');
  try {
    transition(store, ticketId, 'impl', { kind: 'passed' }, () => {
      // 1. The graph run for THIS attempt must exist and be marker-ready.
      const run = graphRunFor(store, ticketId, attempt);
      if (!run) {
        throw new Error(`no graph run for ticket ${ticketId} attempt ${attempt}`);
      }
      if (run.status !== 'completed-awaiting-impl-marker') {
        throw new Error(`graph run ${run.id} is ${run.status}, not marker-ready`);
      }
      // 2. Quiescence is re-read INSIDE the transaction: a completion that
      //    landed between the outside check and here blocks the marker.
      const blockedBy = quiescenceBlockedBy(store.db, run.id);
      if (blockedBy) {
        throw new Error(`graph run ${run.id} is not quiescent (${blockedBy})`);
      }
      // 3. Close the run in the same transaction as the stage advance.
      if (
        !casStatus(
          store.db,
          'approach_graph_runs',
          GRAPH_RUN_TRANSITIONS,
          run.id,
          'completed-awaiting-impl-marker',
          'closed',
        )
      ) {
        throw new Error(`graph run ${run.id} already closed`);
      }
    });
    return { ok: true, graphRunId: graphRunFor(store, ticketId, attempt)?.id };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * The `approach-graph-failed` stage-block write. Goes through the existing
 * `store/stageBlocks.ts` infrastructure — the block is a normal parked stage
 * block, written only while the ticket is still AT `impl`; the graph-side
 * input is the run's persisted `blocked_reason` (the EARLIEST failure by
 * durable event order: the run blocks once, on the first failing event).
 */
export function blockGraphStage(
  store: Store,
  ticketId: number,
  graphRunId: number,
  now: () => string,
): void {
  const ticket = getTicket(store, ticketId);
  if (ticket.stageCurrent !== 'impl') return; // stage-scoped write path
  const run = graphRunFor(store, ticketId, stageAttempt(store, ticketId, 'impl'));
  if (!run || run.id !== graphRunId || run.status !== 'blocked') return;
  parkGateStage(store, {
    ticketId,
    stageKey: 'impl',
    kind: GRAPH_FAILED_BLOCKER,
    reason: `${GRAPH_FAILED_BLOCKER}: ${run.blocked_reason ?? 'graph blocked'} (graph run ${run.id})`,
    runAt: now(),
    gates: [],
  });
}

/** The widened resume outcome (the typed graph-recovery action is defined
 *  HERE; `stageResume` returns it without holding graph logic). */
export type StageResumeResult =
  | { kind: 'cleared' }
  | { kind: 'refused' }
  | { kind: 'graph-recovery'; ticketId: number; graphRunId: number };

/** Resolve the blocked graph run a graph-recovery action points at. */
export function blockedGraphRunFor(store: Store, ticketId: number): number | undefined {
  const ticket = getTicket(store, ticketId);
  const run = graphRunFor(store, ticketId, stageAttempt(store, ticketId, 'impl'));
  return run && run.status === 'blocked' ? run.id : undefined;
}

