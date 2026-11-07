/**
 * Which ticket actions apply to a sidebar row. Host-derived from the SAME pure rules the dashboard's header
 * state uses (closeRules / subtask), so the sidebar menu never offers what the writer would refuse and the
 * view holds no rule logic.
 */
import { canCloseTicket, canReopenTicket } from '../../model/closeRules.js';
import { canDetachSubtask } from '../../model/subtask.js';

export interface TicketActionFlags {
  readonly paused: boolean;
  readonly canClose: boolean;
  readonly canReopen: boolean;
  readonly canDetach: boolean;
}

export function ticketActionFlags(
  ticket: {
    stageCurrent: string | null;
    archivedAt: string | null;
    pausedAt: string | null;
    subtaskParentId: number | null;
    blocksParent: boolean;
    agentState: string | null;
  },
  openChildren: number,
): TicketActionFlags {
  return {
    paused: ticket.pausedAt !== null,
    canClose: canCloseTicket(ticket),
    canReopen: canReopenTicket(ticket),
    canDetach: canDetachSubtask(ticket, openChildren),
  };
}
