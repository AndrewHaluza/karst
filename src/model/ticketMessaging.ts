/**
 * Who may message whom (parent<->child mailbox, v64). Pure, checked at SEND
 * time: a child detached after sending no longer reaches its old parent, and
 * siblings route through the parent. The CLI and any future host sender share
 * this one rule.
 */

/** The ticket facts the rule reads — a structural subset of `Ticket`. */
export interface MessagingTicket {
  id: number;
  projectId: number | null;
  subtaskParentId: number | null;
  archivedAt: string | null;
}

export type MessagingVerdict = { ok: true } | { ok: false; reason: string };

const RULE =
  'a ticket may message only its direct parent or a direct child (same project, recipient not archived)';

/** May `from` address `to`? A refusal names the rule it broke. */
export function checkMessaging(from: MessagingTicket, to: MessagingTicket): MessagingVerdict {
  if (from.id === to.id) return { ok: false, reason: `cannot message yourself — ${RULE}` };
  if (from.projectId !== to.projectId) {
    return { ok: false, reason: `recipient is in a different project — ${RULE}` };
  }
  const direct = from.subtaskParentId === to.id || to.subtaskParentId === from.id;
  if (!direct) {
    return {
      ok: false,
      reason: `recipient is not your direct parent or a direct child — ${RULE}; route via the parent`,
    };
  }
  if (to.archivedAt !== null) {
    return { ok: false, reason: `recipient is archived — ${RULE}` };
  }
  return { ok: true };
}
