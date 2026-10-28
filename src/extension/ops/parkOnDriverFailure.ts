import type { Store } from '../../store/db.js';
import { getTicket } from '../../store/tickets.js';
import { getStage } from '../../store/stages.js';
import { parkGateStage } from '../../store/stageBlocks.js';
import { nowIso } from '../../model/time.js';

/**
 * A driver run that throws must not leave a gate stage `running` with nothing
 * behind it: the stuck-stage sweep would re-drive it into the same error
 * forever. Park the ticket's running gate stage blocked with the error text
 * (the sweep skips blocked stages; Resume re-drives), and log at error with the
 * ticket and stage ids. Returns whether a stage was parked.
 */
export function parkGateOnDriverFailure(
  store: Store,
  ticketId: number,
  err: unknown,
  logError: (message: string, err: unknown) => void,
): boolean {
  const message = err instanceof Error ? err.message : String(err);
  try {
    const stageKey = getTicket(store, ticketId).stageCurrent;
    if (stageKey !== 'uat' && stageKey !== 'review') return false;
    const stage = getStage(store, ticketId, stageKey);
    if (stage?.status !== 'running' || stage.blockedKind !== null) return false;
    parkGateStage(store, {
      ticketId,
      stageKey,
      kind: 'capability-missing',
      reason: `stage driver failed: ${message}`,
      runAt: nowIso(),
      gates: [],
    });
    logError(
      `stage driver: ticket ${ticketId} ${stageKey} (attempt ${stage.attempt}) parked blocked after a driver failure`,
      err,
    );
    return true;
  } catch (parkErr) {
    logError(`stage driver: ticket ${ticketId} could not be parked after a driver failure`, parkErr);
    return false;
  }
}
