/**
 * Approach switch → close the graph run the old approach left open (T1137).
 *
 * `tickets.approach` alone does not end an open graph run, so a switch away
 * from a graph approach had no effect. This runs BEFORE the new approach is
 * persisted: a run whose `approach_id` differs from the new approach is closed
 * through the one Cancel operation. A refusal keeps the old approach, so the
 * ticket never shows the new approach while a graph still owns it.
 */

import type { GraphDb } from '../../store/graph/transitions.js';
import { cancelGraphRun, type CancelGraphRunDeps } from './cancel.js';
import { graphRunLeftByApproachChange } from './entryPoints.js';

export const APPROACH_CHANGED_REASON = 'approach-changed';

export type ApproachChangeCancel =
  | { ok: true; cancelledGraphRunId?: number }
  | { ok: false; message: string };

export async function cancelGraphRunOnApproachChange(
  deps: CancelGraphRunDeps & { db: GraphDb },
  ticketId: number,
  newApproachId: string,
): Promise<ApproachChangeCancel> {
  const run = graphRunLeftByApproachChange(deps.db, ticketId, newApproachId);
  if (run === undefined) return { ok: true };
  const result = await cancelGraphRun(deps, run.graphRunId, APPROACH_CHANGED_REASON);
  switch (result.outcome) {
    case 'cancelled':
      return { ok: true, cancelledGraphRunId: run.graphRunId };
    case 'already-terminal':
      return { ok: true };
    case 'refused-live-process': {
      const pids = [...new Set(result.refusals.map((r) => r.pid))].join(', ');
      return {
        ok: false,
        message: `The approach was not changed: graph run ${run.graphRunId} still has a live process (pid ${pids}) that Karst cannot stop. Stop that process, then change the approach again.`,
      };
    }
    case 'raced':
      return {
        ok: false,
        message: `The approach was not changed: graph run ${run.graphRunId} changed state while it was cancelled. Try again.`,
      };
  }
}

/**
 * The ticket form's `cancelGraphRunForApproachChange` dep, bound to a lazily
 * resolved cancel context. No context (no graph store yet) means no graph run
 * can exist, so the change is allowed. `onCancelled` refreshes the dashboard.
 */
export function bindApproachChangeCancel(
  resolve: () => CancelGraphRunDeps | undefined,
  onCancelled: (ticketId: number) => void,
): (ticketId: number, approachId: string) => Promise<ApproachChangeCancel> {
  return async (ticketId, approachId) => {
    const deps = resolve();
    if (!deps) return { ok: true };
    const result = await cancelGraphRunOnApproachChange(deps, ticketId, approachId);
    if (result.ok && result.cancelledGraphRunId !== undefined) onCancelled(ticketId);
    return result;
  };
}
