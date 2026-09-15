import type { Store } from '../../store/db.js';
import { getTicket } from '../../store/tickets.js';
import { latestFindingBatch } from '../../store/reviewFindings.js';
import { listGateRuns } from '../../store/gateRuns.js';
import { activeRecoverySeries } from '../../store/recoveryRounds.js';
import { listPrFeedbackForRound } from '../../store/prFeedback.js';
import { renderFixBrief } from '../../agent/fixBrief.js';

/**
 * The fix brief for a ticket at `fix`, carrying the reviewer comments when the
 * fix is a PR-feedback (`ship`-sourced) recovery round.
 *
 * Extracted so every host launch path — the driver's resume AND the interactive
 * session seed — renders the SAME brief, and so `extension.ts` stays a thin
 * binding (ops/ is the point; the file is line-capped). A `ship` round is the
 * only source that adopts `pr_feedback`, so the feedback is non-empty only then;
 * `renderFixBrief` itself guards the ship block by the failing gate's stage.
 *
 * Reads the store; imports no `vscode`.
 */
export function fixBriefForTicket(store: Store, ticketId: number, label?: string): string | null {
  const t = getTicket(store, ticketId);
  const shipRound = activeRecoverySeries(store, ticketId, 'ship');
  return renderFixBrief(
    label ?? t.key ?? `#${ticketId}`,
    t.stages,
    latestFindingBatch(store, ticketId),
    listGateRuns(store, ticketId),
    shipRound === null ? undefined : listPrFeedbackForRound(store, ticketId, shipRound.id),
  );
}
