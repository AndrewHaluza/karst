import type { Store } from '../../store/db.js';
import { getTicket, type TicketWithStages } from '../../store/tickets.js';

export type TicketListDestination = 'edit' | 'dashboard';

export interface TicketListNavigationActions {
  edit(ticketId: number): void | PromiseLike<unknown>;
  openDashboard(ticketId: number): void | PromiseLike<unknown>;
  onError(error: unknown): void;
}

/**
 * Destination for an ordinary ticket-list selection. Scope completion is the
 * persisted scope-stage verdict — selected repositories alone are still only a
 * draft and must lead back to editing.
 */
export function ticketListDestination(ticket: TicketWithStages): TicketListDestination {
  return ticket.stages.some((stage) => stage.stageKey === 'scope' && stage.status === 'passed')
    ? 'dashboard'
    : 'edit';
}

/** Load the selected ticket, then preserve its id through the chosen list action. */
export function openTicketFromList(
  store: Store,
  ticketId: number,
  actions: TicketListNavigationActions,
): void {
  const destination = ticketListDestination(getTicket(store, ticketId));
  const result = destination === 'dashboard'
    ? actions.openDashboard(ticketId)
    : actions.edit(ticketId);
  if (result) void Promise.resolve(result).catch(actions.onError);
}
