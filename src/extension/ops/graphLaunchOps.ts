import type { Store } from '../../store/db.js';
import { setStage } from '../../store/stages.js';
import { maxGraphRunStageAttemptForTicket } from '../../store/graph/graphRuns.js';
import type { GraphLaunchDecision } from '../../approaches/graph/launchGuard.js';
import { formatId } from '../../model/entityId.js';

/**
 * When a graph run for the current impl attempt terminated (cancelled or stale),
 * advance the impl stage attempt so the next run can bootstrap cleanly under the
 * strict UNIQUE (ticket_id, stage_attempt) invariant.
 * Returns true if the attempt was advanced, or false if the decision status is not advanceable.
 */
export function advanceConsumedGraphAttempt(
  store: Store,
  ticketId: number,
  decision: Extract<GraphLaunchDecision, { kind: 'attempt-consumed' }>,
  currentAttempt: number,
  log?: (message: string) => void,
): boolean {
  if (decision.status !== 'cancelled' && decision.status !== 'stale') return false;
  const maxGraphAttempt = maxGraphRunStageAttemptForTicket(store.db, ticketId);
  const nextAttempt = Math.max(currentAttempt, maxGraphAttempt ?? -1) + 1;
  setStage(store, ticketId, 'impl', { attempt: nextAttempt });
  log?.(
    `karst: advanced ticket ${formatId('ticket', ticketId)} impl attempt to ${nextAttempt} following terminal (${decision.status}) graph run ${decision.graphRunId}`,
  );
  return true;
}
