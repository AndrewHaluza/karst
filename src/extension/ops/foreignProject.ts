import type { Store } from '../../store/db.js';
import { getTicket } from '../../store/tickets.js';

/**
 * A hook event is routed by a global, last-writer-wins endpoint file, so a window
 * can receive an event for a ticket of another project. That window holds a
 * different manifest and must not act on the ticket. Fail open: a window with no
 * project, or a legacy ticket with no project id, is never refused.
 */
export function isForeignProjectTicket(
  store: Store,
  ticketId: number,
  currentProjectId: number | undefined | null,
): boolean {
  if (currentProjectId == null) return false;
  let ticketProjectId: number | null;
  try {
    ticketProjectId = getTicket(store, ticketId).projectId;
  } catch {
    return false;
  }
  return ticketProjectId != null && ticketProjectId !== currentProjectId;
}

/** Returns true (and logs the refusal) when the ticket belongs to another project. */
export function refuseForeignProjectTicket(
  store: Store,
  ticketId: number,
  currentProjectId: number | undefined | null,
  trigger: string,
  log: (message: string) => void,
): boolean {
  if (!isForeignProjectTicket(store, ticketId, currentProjectId)) return false;
  log(`stage driver: ${trigger} → ticket ${ticketId} refused (belongs to another project than this window's project ${currentProjectId})`);
  return true;
}

/**
 * Wrap a hook notifier so an event for a ticket of another project reaches none
 * of its side effects (artifact capture, session ownership, drive, auto-deliver).
 */
export function guardHookNotify<P>(
  store: Store,
  currentProjectId: () => number | undefined | null,
  log: (message: string) => void,
  notify: (ticketId: number, payload: P) => void,
): (ticketId: number, payload: P) => void {
  return (ticketId, payload) => {
    if (refuseForeignProjectTicket(store, ticketId, currentProjectId(), 'hook', log)) return;
    notify(ticketId, payload);
  };
}
