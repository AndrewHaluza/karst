import type { Store } from '../../store/db.js';
import { getTicket } from '../../store/tickets.js';
import { SEND_BACK_EVENT_PREFIX } from '../../workflow/sendBack.js';
import { listInbox, markRead } from '../../store/ticketMessages.js';

/** The done-marker sentence that ends every send-back brief. */
export const SEND_BACK_DONE_MARKER =
  'Fix the failure in the worktree, then call the karst MCP tool `stage` with { stage: "impl" } to mark the work done.';

export interface SendBackBrief {
  /** The latest send-back reason plus the done marker. */
  text: string;
  /** Every unread host event the brief covers; the caller marks them read. */
  messageIds: number[];
}

/**
 * The brief for a launch at `impl` that never received the hand-off: the
 * unread host events (`kind 'event'`, no sender) that `sendBackToImplement`
 * wrote. A peer-ticket message is never a brief. Reads only; imports no `vscode`.
 */
export function sendBackBriefForTicket(store: Store, ticketId: number): SendBackBrief | null {
  // Only `impl` takes this brief; `fix` keeps `fixBriefForTicket`.
  if (getTicket(store, ticketId).stageCurrent !== 'impl') return null;
  const events = listInbox(store, ticketId, { unreadOnly: true }).filter(
    (m) => m.kind === 'event' && m.fromTicketId === null && m.body.startsWith(SEND_BACK_EVENT_PREFIX),
  );
  const latest = events[events.length - 1];
  if (latest === undefined) return null;
  return { text: `${latest.body.slice(SEND_BACK_EVENT_PREFIX.length)}\n${SEND_BACK_DONE_MARKER}`, messageIds: events.map((m) => m.id) };
}

/**
 * Mark the send-back events read once a hand-off delivered the reason to a
 * session (a nudge or a seeded launch). A later launch at `impl` then does not
 * replay a reason the agent already received.
 */
export function markSendBackDelivered(store: Store, ticketId: number): void {
  const brief = sendBackBriefForTicket(store, ticketId);
  if (brief !== null) markRead(store, brief.messageIds);
}
