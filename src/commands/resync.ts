import type { Store } from '../store/db.js';
import { listTickets, type TicketWithStages } from '../store/tickets.js';
import { reconcileOnStart, type IsAlive, type DeadServer } from '../recovery/reconcile.js';

/**
 * Manual Resync command (§13, MVP §2.3). Re-scans the world — reconciles stage
 * state and dead servers (via `reconcileOnStart`) — then returns a fresh
 * registry snapshot the UI can rebuild its view from. SQLite stays the single
 * source of truth; Resync just re-derives the live view over it.
 */
export interface RegistrySnapshot {
  tickets: TicketWithStages[];
  deadServers: DeadServer[];
}

export function resync(store: Store, isAlive: IsAlive): RegistrySnapshot {
  const { deadServers } = reconcileOnStart(store, isAlive);
  return { tickets: listTickets(store), deadServers };
}
