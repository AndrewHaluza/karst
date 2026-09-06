/**
 * The graph-approach launch guard (H3).
 *
 * A graph ticket at `impl` either has a run the coordinator owns, or it needs
 * one started. The guard used to answer that with "does ANY graph run row
 * exist for this ticket", in any status, and route every hit to the Inside
 * panel with "the coordinator owns continuation". For a `closed`, `cancelled`
 * or `stale` run that claim is false — a terminal run is owned by nobody — so
 * a ticket whose previous attempt ended (uat failed it back to impl, or the
 * reconcile cancelled the run when the ticket left impl) could never start a
 * graph again. The Inside panel offers a typed control for `blocked` and (H2)
 * for a stopped drain; it offers nothing at all for a terminal run.
 *
 * Two facts bound what the guard may allow:
 *
 *  - `UNIQUE (ticket_id, stage_attempt)` on `approach_graph_runs`: an impl
 *    attempt hosts at most one graph run, ever.
 *  - `karst node` rejects a completion whose run's `stage_attempt` is not the
 *    ticket's current impl attempt (`cli/node.ts`, `wrong-attempt`).
 *
 * So a run's attempt is a stage fact, never ours to allocate: a terminal run
 * occupying the CURRENT attempt genuinely leaves no room for another, and the
 * only honest answer is to say so — a new impl attempt (a stage failure and
 * re-entry) is what opens the next one. A terminal run at an OLDER attempt is
 * simply history, and must not stand in the way.
 *
 * Host-agnostic: a db handle and the two ticket facts, no vscode. The optional
 * `debug` callback follows the same injected-callback rule every other
 * vscode-free module here does — the guard is the first thing a "why will my
 * ticket not start a graph" investigation asks about, and its three answers are
 * otherwise invisible.
 */

import type { GraphDb } from '../../store/graph/transitions.js';

/** Statuses whose run will never mutate again — nothing owns continuation. */
const TERMINAL_RUN_STATUSES = ['closed', 'cancelled', 'stale'] as const;

export type GraphLaunchDecision =
  /** No run stands in the way: bootstrap a new one for this attempt. */
  | { kind: 'launch' }
  /** A live run exists; the coordinator owns its continuation. */
  | { kind: 'owned'; graphRunId: number; status: string }
  /** A terminal run already consumed this impl attempt; only a NEW attempt
   *  can host another run. */
  | { kind: 'attempt-consumed'; graphRunId: number; status: string; stageAttempt: number };

/**
 * Decide whether a graph-approach ticket at `impl` may launch a new run.
 * `currentAttempt` is the ticket's current impl stage attempt — the attempt
 * the new run would be created with.
 */
export function graphLaunchDecision(
  db: GraphDb,
  ticketId: number,
  currentAttempt: number,
  debug?: (message: string) => void,
): GraphLaunchDecision {
  debug?.(`[graph] launch guard: ticket ${ticketId} at impl attempt ${currentAttempt}`);
  const live = db
    .prepare(
      `SELECT id, status FROM approach_graph_runs
       WHERE ticket_id = ? AND status NOT IN (${TERMINAL_RUN_STATUSES.map(() => '?').join(',')})
       ORDER BY id DESC LIMIT 1`,
    )
    .get(ticketId, ...TERMINAL_RUN_STATUSES) as { id: number; status: string } | undefined;
  if (live) {
    debug?.(`[graph] launch guard: run ${live.id} is live (${live.status}) — the coordinator owns it`);
    return { kind: 'owned', graphRunId: live.id, status: live.status };
  }

  const consumed = db
    .prepare(
      'SELECT id, status FROM approach_graph_runs WHERE ticket_id = ? AND stage_attempt = ? LIMIT 1',
    )
    .get(ticketId, currentAttempt) as { id: number; status: string } | undefined;
  if (consumed) {
    debug?.(
      `[graph] launch guard: run ${consumed.id} (${consumed.status}) already consumed attempt ${currentAttempt}`,
    );
    return {
      kind: 'attempt-consumed',
      graphRunId: consumed.id,
      status: consumed.status,
      stageAttempt: currentAttempt,
    };
  }
  debug?.(`[graph] launch guard: no run stands in the way — launching`);
  return { kind: 'launch' };
}
