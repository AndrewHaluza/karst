import type { Store } from '../../store/db.js';
import { getTicket } from '../../store/tickets.js';
import { listGateRuns } from '../../store/gateRuns.js';
import { activeRecoverySeries } from '../../store/recoveryRounds.js';
import { listPrFeedbackForRound } from '../../store/prFeedback.js';
import { hasLinkedPrototype, renderFixBrief } from '../../agent/fixBrief.js';
import { latestReviewBatch, stallNote } from '../../store/stallNote.js';
import { formatTicketRef } from '../../model/entityId.js';

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
  const brief = renderFixBrief(
    label ?? formatTicketRef(ticketId, t.key),
    t.stages,
    latestReviewBatch(store, ticketId),
    listGateRuns(store, ticketId),
    shipRound === null ? undefined : listPrFeedbackForRound(store, ticketId, shipRound.id),
    { hasPrototype: hasLinkedPrototype(t) },
  );
  // The note of an applied stall option leads the brief (D99 path): the fix
  // agent reads the direction first, and findings on removed scope lapse.
  const note = stallNote(store, ticketId);
  if (note === null) return brief;
  const lead =
    `## Direction from the user\n\n${note}\n\n` +
    'Findings on scope that this direction removes no longer apply.\n';
  return brief === null ? lead : `${lead}\n---\n\n${brief}`;
}
