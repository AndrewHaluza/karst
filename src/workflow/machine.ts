import type { Store } from '../store/db.js';
import type { StageKey, Verdict } from '../model/types.js';
import { setStage, type StagePatch } from '../store/stages.js';
import { getTicket } from '../store/tickets.js';
import { STAGE_GRAPH, isTerminal, needsConfirm } from './graph.js';
import { nowIso } from '../model/time.js';

/**
 * How a stage is entered — what "arriving here" means for that kind of stage.
 *
 * - Terminal: arriving IS finishing. Nothing runs and no verdict can follow, so
 *   left 'running' it would park every shipped ticket on a blue, forever-running
 *   `done` node, filed under "In progress" (facets.ts).
 * - Confirm: arriving is *parking*. Nothing runs until the user clicks, so
 *   'running' claimed work nobody was doing — the same wrong-glyph bug one stage
 *   earlier, and the reason a ticket blocked on the user never read as needs-you.
 *   `endedAt` is cleared because a re-entry (fix → review → ship) must not
 *   inherit a previous attempt's end time: `deriveStageCurrent` ranks stages by
 *   `endedAt ?? startedAt`, so a stale one makes the parked stage look older than
 *   the stage it just came from.
 * - Everything else: entering it starts it.
 *
 * Every entry clears `verdict`. `stages` is keyed (ticket_id, stage_key), so a
 * re-entry OVERWRITES the row rather than appending to it: the column says what
 * this stage reports NOW, and the history of why an earlier attempt failed lives
 * in `gate_runs`. Kept, the reason outlives the attempt it belonged to — a
 * review re-entered after a fix reads `status: running` beside
 * `verdict: "gates failed: lint"`.
 */
function entryPatch(next: StageKey, at: string): StagePatch {
  if (isTerminal(next)) return { status: 'passed', verdict: null, startedAt: at, endedAt: at };
  if (needsConfirm(next)) {
    return { status: 'pending', verdict: null, startedAt: at, endedAt: null };
  }
  // `endedAt` is cleared for the same reason the confirm branch above clears
  // it, and the omission here was a live corruption: `setStage` patches only
  // the fields it is given, so a stage RE-ENTERED running kept the `ended_at`
  // of whatever ran last — a different run entirely. That left rows reading
  // `running` with an `ended_at` 33 minutes BEFORE their `started_at`, which
  // reads as a stage that finished before it began and made a live UAT look
  // hung. Every other writer that enters a stage `running` already cleared it
  // (sendBack.ts, stages/ship.ts, recoveryRounds.ts's markFixStageLive); this
  // was the only path that did not, and it is the most travelled one.
  return { status: 'running', verdict: null, startedAt: at, endedAt: null };
}

/**
 * Advance a ticket from `from` given a `verdict`, returning the next stage
 * (§11, §5.4). Every transition is one atomic mutation over `stages` + the
 * ticket's `stage_current`.
 *
 * Invariants:
 *  - **No inference (§5.4):** a `null` verdict never transitions — throws. Only a
 *    definite pass/fail/bypassed moves a stage.
 *  - **Deterministic edges:** the verdict kind selects the edge from `STAGE_GRAPH`.
 *    A `bypassed` verdict takes the forward (`passed`) edge — the pipeline
 *    continues — while the row records `bypassed`, never a gate pass. A stage
 *    with no edge for that kind (fail at `scope`, any verdict at `done`) throws
 *    rather than silently no-op.
 *  - **Attempt tracks loops:** a failing stage's `attempt` climbs on each fail,
 *    so the fix→revalidate loop is countable.
 */
export function transition(
  store: Store,
  ticketId: number,
  from: StageKey,
  verdict: Verdict,
  /**
   * Optional pre-mutation run inside the *same* transaction as the verdict —
   * used to fold a stage's artifact write in atomically, so evidence and
   * verdict are never committed separately (they land together or not at all).
   */
  premutate?: () => void,
): StageKey {
  if (verdict === null) {
    throw new Error(
      `no-inference: refusing to transition ${from} for ticket ${ticketId} without a verdict`,
    );
  }

  const edges = STAGE_GRAPH[from];
  // `bypassed` is a deliberate skip, not a failure: it takes the SAME forward
  // edge as `passed` — the pipeline continues — while the row below records it
  // as `bypassed`, never as a gate pass.
  const next = verdict.kind === 'failed' ? edges.failed : edges.passed;
  if (!next) {
    throw new Error(
      `no ${verdict.kind} edge from stage '${from}' (ticket ${ticketId})`,
    );
  }

  const apply = store.db.transaction(() => {
    // Guarded BEFORE premutate and before any write: `transition` used to check
    // only that a row existed for `from`, never that it was the ticket's CURRENT
    // stage — so a transition could be authored from a stage the ticket already
    // left, and two windows sweeping the same ticket could both advance it. The
    // refusal must mutate nothing, including the premutate evidence write, so it
    // runs first inside the transaction.
    const ticket = getTicket(store, ticketId);
    if (ticket.stageCurrent !== from) {
      throw new Error(
        `stage '${from}' is not ticket ${ticketId}'s current stage (${ticket.stageCurrent})`,
      );
    }

    if (premutate) premutate();

    const current = ticket.stages.find((s) => s.stageKey === from);
    if (!current) throw new Error(`ticket ${ticketId} has no stage '${from}'`);

    if (verdict.kind === 'passed') {
      // `verdict` is cleared for the same reason `entryPatch` clears it: a pass
      // is this row's current answer, and a stale failure reason beside it is
      // read as a contradiction. A stage that never entered through the machine
      // (a first attempt driven straight to a pass) is covered here too.
      setStage(store, ticketId, from, { status: 'passed', verdict: null, endedAt: nowIso() });
    } else if (verdict.kind === 'bypassed') {
      // Every gate was deliberately disabled: the stage did not gate and did
      // not prove a pass, but it still advances. Recorded as its own status so
      // no surface can mistake it for a green gate (the user's decision).
      setStage(store, ticketId, from, { status: 'bypassed', verdict: null, endedAt: nowIso() });
    } else {
      setStage(store, ticketId, from, {
        status: 'failed',
        attempt: current.attempt + 1,
        verdict: verdict.reason ?? null,
        endedAt: nowIso(),
      });
    }

    // What entering the next stage means depends on the kind of stage it is —
    // see `entryPatch`. Only a stage that actually runs is entered as running.
    const at = nowIso();
    setStage(store, ticketId, next, entryPatch(next, at));
    store.db
      .prepare('UPDATE tickets SET stage_current = ? WHERE id = ?')
      .run(next, ticketId);
  });
  apply();

  return next;
}
