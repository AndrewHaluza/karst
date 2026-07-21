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
 */
function entryPatch(next: StageKey, at: string): StagePatch {
  if (isTerminal(next)) return { status: 'passed', startedAt: at, endedAt: at };
  if (needsConfirm(next)) return { status: 'pending', startedAt: at, endedAt: null };
  return { status: 'running', startedAt: at };
}

/**
 * Advance a ticket from `from` given a `verdict`, returning the next stage
 * (§11, §5.4). Every transition is one atomic mutation over `stages` + the
 * ticket's `stage_current`.
 *
 * Invariants:
 *  - **No inference (§5.4):** a `null` verdict never transitions — throws. Only a
 *    definite pass/fail moves a stage.
 *  - **Deterministic edges:** the verdict kind selects the edge from `STAGE_GRAPH`.
 *    A stage with no edge for that kind (fail at `scope`, any verdict at `done`)
 *    throws rather than silently no-op.
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
  const next = verdict.kind === 'passed' ? edges.passed : edges.failed;
  if (!next) {
    throw new Error(
      `no ${verdict.kind} edge from stage '${from}' (ticket ${ticketId})`,
    );
  }

  const apply = store.db.transaction(() => {
    if (premutate) premutate();

    const current = getTicket(store, ticketId).stages.find((s) => s.stageKey === from);
    if (!current) throw new Error(`ticket ${ticketId} has no stage '${from}'`);

    if (verdict.kind === 'passed') {
      setStage(store, ticketId, from, { status: 'passed', endedAt: nowIso() });
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
