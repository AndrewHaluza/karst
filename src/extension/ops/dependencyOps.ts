import type { Store } from '../../store/db.js';
import { areRelated } from '../../store/ticketRelations.js';

export interface DependencyOpsDeps {
  openDashboard: (ticketId: number) => void;
}

/**
 * Open the ticket's dashboard if it has a relation to another ticket.
 * Used to navigate the ticket graph from Dependencies sections.
 */
export function makeDependencyOps(store: Store, deps: DependencyOpsDeps) {
  return {
    openDependency: (ticketId: number, targetTicketId: number) => {
      if (areRelated(store, ticketId, targetTicketId)) {
        deps.openDashboard(targetTicketId);
      }
    },
  };
}
