import type { Store } from '../store/db.js';
import type { StageKey, Verdict } from '../model/types.js';
import { setStage } from '../store/stages.js';
import { getTicket } from '../store/tickets.js';
import { STAGE_GRAPH } from './graph.js';

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

    // The stage we move into starts running.
    setStage(store, ticketId, next, { status: 'running', startedAt: nowIso() });
    store.db
      .prepare('UPDATE tickets SET stage_current = ? WHERE id = ?')
      .run(next, ticketId);
  });
  apply();

  return next;
}

function nowIso(): string {
  return new Date().toISOString();
}
