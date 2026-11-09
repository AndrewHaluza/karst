import type { Store } from '../../store/db.js';
import { getTicket, updateTicketFields } from '../../store/tickets.js';
import type { PriorityLevel } from '../../planning/proposal.js';
import { formatId } from '../../model/entityId.js';
import type { Notify } from './notify.js';

/** A ticket takes a local priority only while it has not started. */
export const PRIORITY_EDITABLE_STAGE = 'scope';

export interface TicketPriorityDeps {
  readonly store: Store;
  readonly projectId: () => number | undefined;
  readonly notify: Notify;
  readonly onChange: () => void;
}

/** Why a ticket cannot take a priority from the sidebar, or null when it can. */
export function priorityRefusal(
  store: Store,
  ticketId: number,
  projectId: number | undefined,
): string | null {
  let t;
  try {
    t = getTicket(store, ticketId);
  } catch {
    return 'was not found';
  }
  if (t.projectId !== projectId) return 'was not found';
  if (t.archivedAt !== null) return 'is archived';
  if (t.subtaskParentId !== null) return 'is a sub-task';
  if (t.stageCurrent !== PRIORITY_EDITABLE_STAGE) return `has left ${PRIORITY_EDITABLE_STAGE}`;
  return null;
}

/**
 * Set (or clear with `null`) the priority of a top-level ticket at `scope`.
 * The level goes to the host-owned `priority_override`, so a provider fetch never
 * overwrites it; Clear removes the override and the provider value shows again.
 * Nothing is written back to the provider.
 */
export async function setTicketPriorityOp(
  deps: TicketPriorityDeps,
  ticketId: number,
  level: PriorityLevel | null,
): Promise<void> {
  const label = formatId('ticket', ticketId);
  const refusal = priorityRefusal(deps.store, ticketId, deps.projectId());
  if (refusal !== null) {
    await deps.notify.error(`Ticket ${label} ${refusal}; its priority was not changed.`);
    return;
  }
  updateTicketFields(deps.store, ticketId, { priorityOverride: level });
  deps.onChange();
}
