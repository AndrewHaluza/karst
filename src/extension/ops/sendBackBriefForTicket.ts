import type { Store } from '../../store/db.js';
import { getTicket } from '../../store/tickets.js';
import { SEND_BACK_EVENT_PREFIX } from '../../workflow/sendBack.js';
import { listInbox } from '../../store/ticketMessages.js';

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
