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
 *     `closed`, then best-effort cleans any terminal workspace the node-level
 *     completion path did not already remove. Any earlier marker is rejected
 *     WITHOUT mutation. The graph status is an ENTRY CONDITION, never a
 *     verdict: the scheduler never writes or infers `passed`.
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
import { parkGateStage, stageBlock, clearStageBlock } from '../store/stageBlocks.js';
import { stageAttempt } from '../store/stages.js';
import { casStatus, GRAPH_RUN_TRANSITIONS } from '../store/graph/transitions.js';
import { quiescenceBlockedBy, earliestFaultNodeRun, faultNodeRunReason } from '../approaches/graph/coordinator/completion.js';
import { GRAPH_FAILED_BLOCKER } from '../approaches/graph/coordinator/recovery.js';
import { BUILT_IN_PACKAGE_ID } from '../approaches/builtInId.js';
import { cleanupTerminalGraphRunWorkspaces } from '../approaches/graph/workspace/cleanup.js';
import { runImmediateTransaction } from '../store/transactions.js';
import { assertMarkerNotWhileWaiting, liveAgentState } from './markerGuard.js';

export { GRAPH_FAILED_BLOCKER };

/**
 * Same shape as `GRAPH_FAILED_BLOCKER`: not "karst could not ask" — the
 * question was asked (the graph finished) and is simply unanswered yet. See
 * `BlockerKind`'s `awaiting-impl-marker` member for the full rationale.
 */
export const GRAPH_MARKER_WAIT_BLOCKER = 'awaiting-impl-marker' as const;

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
 * True when a ticket is on the built-in graph approach but has NO graph run
 * at all — bootstrap failed, the run was cancelled before it was created, or
 * a misconfiguration skipped it. Done must mean the work happened: such a
 * ticket must never fall through to the plain impl marker, which would
 * advance it to `uat` with zero graph work performed. Only the built-in
 * `karst-graph-engineering` approach id is graph-runtime-backed (a `graph:`
 * block on any other approach id is inert — see `manifest/types.ts`), so
 * that id is the only safe, manifest-free signal available at this layer.
 */
export function graphApproachMissingRun(store: Store, ticketId: number): boolean {
  const ticket = getTicket(store, ticketId);
  if (ticket.approach !== BUILT_IN_PACKAGE_ID) return false;
  const row = store.db
    .prepare('SELECT 1 AS x FROM approach_graph_runs WHERE ticket_id = ? LIMIT 1')
    .get(ticketId);
  return row === undefined;
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
  let closedGraphRunId: number | undefined;
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
      closedGraphRunId = run.id;
      // 4. The marker just answered the wait — clear it, same as recovery.ts
      //    clears GRAPH_FAILED_BLOCKER, and ONLY if it's our own kind (never
      //    stomp an unrelated block).
      const block = stageBlock(store, ticketId, 'impl');
      if (block && block.kind === GRAPH_MARKER_WAIT_BLOCKER) {
        clearStageBlock(store, ticketId, 'impl');
      }
    });
    if (closedGraphRunId !== undefined) {
      try {
        cleanupTerminalGraphRunWorkspaces(
          {
            store,
            transaction: <T>(fn: () => T): T => runImmediateTransaction(store.db, fn),
          },
          { graphRunId: closedGraphRunId },
        );
      } catch {
        // The run close and stage transition are already committed. Workspace
        // cleanup is best-effort and must never change the marker verdict.
      }
    }
    return { ok: true, graphRunId: closedGraphRunId };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * The impl marker's second legitimate caller: a trusted host action (a
 * dashboard click), never agent-facing argv. `cli/stage.ts`'s
 * `runStageCommand` is still the ONLY parser that turns untrusted argv into a
 * marker call — this function has no argv, takes only a ticket id the panel
 * already proved belongs to the open registry, and enforces the SAME
 * `assertMarkerNotWhileWaiting` invariant `runStageCommand` does, read live
 * so a question asked after the panel's snapshot still refuses the click. A
 * host caller that skipped this and called `graphImplMarkerGuard` directly
 * would fire the marker while the agent is mid-question — exactly the
 * premature-advance `assertMarkerNotWhileWaiting` exists to stop.
 */
export function fireGraphImplMarkerFromHost(store: Store, ticketId: number): GraphMarkerGuardResult {
  try {
    assertMarkerNotWhileWaiting(liveAgentState(store, ticketId));
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
  return graphImplMarkerGuard(store, ticketId);
}

/**
 * The `approach-graph-failed` stage-block write. Goes through the existing
 * `store/stageBlocks.ts` infrastructure — the block is a normal parked stage
 * block, written only while the ticket is still AT `impl`. The graph-side
 * input is the run's persisted `blocked_reason` (the EARLIEST failure by
 * durable event order: the run blocks once, on the first failing event).
 *
 * Slice 5 Task 6: when MULTIPLE node runs fault at once, the block names the
 * EARLIEST by durable event order (the lowest node-run id) — computed here
 * from the run's faulted node runs, never from whichever block happened to
 * commit first. The run's own `blocked_reason` is the fallback only when no
 * node-level fault is recorded (a run-level block like graph-budget-exhausted).
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
  const earliest = earliestFaultNodeRun(store.db, graphRunId);
  const reason = earliest ? faultNodeRunReason(earliest) : (run.blocked_reason ?? 'graph blocked');
  parkGateStage(store, {
    ticketId,
    stageKey: 'impl',
    kind: GRAPH_FAILED_BLOCKER,
    reason: `${GRAPH_FAILED_BLOCKER}: ${reason} (graph run ${run.id})`,
    runAt: now(),
    gates: [],
  });
}

/**
 * The `awaiting-impl-marker` stage-block write: the graph flipped
 * `completed-awaiting-impl-marker` (`flipOnEndQuiescence`), so the wait is
 * now visible on the stage row itself, the same way `blockGraphStage` makes
 * a graph fault visible. Written only while the ticket is still AT `impl`
 * and only while the run is genuinely marker-ready — a raced close (the
 * marker landed between the flip and this call) is a no-op, never a stale
 * block on a stage that already advanced.
 */
export function markGraphAwaitingImplMarker(
  store: Store,
  ticketId: number,
  graphRunId: number,
  now: () => string,
): void {
  const ticket = getTicket(store, ticketId);
  if (ticket.stageCurrent !== 'impl') return; // stage-scoped write path
  const run = graphRunFor(store, ticketId, stageAttempt(store, ticketId, 'impl'));
  if (!run || run.id !== graphRunId || run.status !== 'completed-awaiting-impl-marker') return;
  parkGateStage(store, {
    ticketId,
    stageKey: 'impl',
    kind: GRAPH_MARKER_WAIT_BLOCKER,
    reason: `${GRAPH_MARKER_WAIT_BLOCKER}: graph run ${run.id} completed, waiting for the impl marker`,
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
