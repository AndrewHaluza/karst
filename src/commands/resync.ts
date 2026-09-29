import type { Store } from '../store/db.js';
import { listTickets, type ProjectScope, type TicketWithStages } from '../store/tickets.js';
import { reconcileOnStart, type IsAlive, type DeadServer } from '../recovery/reconcile.js';
import { recoverAwaitingSubtasks } from '../workflow/subtaskGate.js';

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

/**
 * The two halves scope differently, on purpose (§ projects / multi-window):
 *  - **reconcile** stays global. A dead server or a drifted `stage_current` in
 *    another project is still wrong, and scoping the sweep would leave it that
 *    way until that project's window happened to open. It is idempotent and
 *    pid-guarded, so touching another project's rows is safe.
 *  - **the returned snapshot** is scoped, because it feeds a window's view, and
 *    a window must never render another project's tickets.
 */
export function resync(store: Store, isAlive: IsAlive, scope: ProjectScope = {}): RegistrySnapshot {
  const { deadServers } = reconcileOnStart(store, isAlive);
  // Re-derive sub-task blocks synchronously. This is the manual Resync command:
  // it holds no git runner, so it cannot integrate (NDL-75 does that on the
  // landing paths, the driver seam, and boot). Integration parks are left alone
  // by `onSubtaskLanded`.
  recoverAwaitingSubtasks(store);
  return { tickets: listTickets(store, scope), deadServers };
}
