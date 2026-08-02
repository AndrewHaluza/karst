import type { Store } from '../store/db.js';
import { getTicket } from '../store/tickets.js';
import { clearStageBlock, stageBlock } from '../store/stageBlocks.js';
import type { StageKey } from '../model/types.js';

/**
 * Validate and apply a dashboard `stage-resume` request (§ blocked state
 * visible). The webview message carries its own `ticketId`/`stageKey`, but
 * neither is trusted: this is the ONE place both are checked against the
 * ticket the panel actually owns, right before the store is mutated —
 * `extension.ts` stays a thin binding that calls this and, only on `true`,
 * drives the ticket forward.
 *
 * Refuses (returns false, mutates nothing) when:
 * - the message names a different ticket than the panel is scoped to — a
 *   crafted message must not reach across tickets;
 * - the ticket has since left the named stage — a stale panel's message must
 *   not resume a stage the ticket is not at;
 * - the named stage carries no block at all — nothing to clear.
 */
export function resumeBlockedStage(
  store: Store,
  panelTicketId: number,
  msgTicketId: number,
  stageKey: StageKey,
): boolean {
  if (msgTicketId !== panelTicketId) return false;
  const ticket = getTicket(store, panelTicketId);
  if (ticket.stageCurrent !== stageKey) return false;
  if (!stageBlock(store, panelTicketId, stageKey)) return false;
  clearStageBlock(store, panelTicketId, stageKey);
  return true;
}
