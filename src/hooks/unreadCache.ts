import type { Store } from '../store/db.js';
import { unreadByRecipient, unreadForTicket, type RecipientUnread } from '../store/messageDelivery.js';

/**
 * The in-memory unread count the hook endpoint reads when a recipient's turn
 * ends, so the reply can be built WITHOUT a DB query in the reply builder
 * (PROMPT-16 latency: the hook handler runs in the extension host's event loop
 * beside every other tick).
 *
 * The cache is a PROJECT-WINDOW view. Two writers keep it fresh:
 *  - the delivery sweep rebuilds it from the store every tick (`replace`);
 *  - the hook endpoint tops up ONE ticket from the store when that ticket's
 *    turn ends (`refreshTicket`), so a `message send` — a SEPARATE CLI process
 *    whose write this host never sees directly — is reflected on the very next
 *    turn end rather than waiting for the next sweep.
 * `get`/`watermark` are pure in-memory reads: the reply builder itself never
 * touches the DB.
 */
export interface UnreadCache {
  /** The unread count for a ticket, `0` when it has none. */
  get(ticketId: number): number;
  /**
   * The highest unread message id for a ticket (`0` when none). This is the
   * BATCH identity: a read followed by a same-sized new batch has the same
   * count but a higher watermark, so the reply's one-block guard keys on the
   * watermark, not the count, and never swallows the new batch.
   */
  watermark(ticketId: number): number;
  /** Rebuild the whole cache from a project's unread rows. */
  replace(rows: readonly RecipientUnread[]): void;
  /** Rebuild the whole cache from the store for one project. */
  refresh(store: Store, projectId: number): void;
  /** Refresh ONE ticket's entry from the store (the reply path's top-up). */
  refreshTicket(store: Store, ticketId: number): void;
  clear(): void;
}

export function createUnreadCache(): UnreadCache {
  const entries = new Map<number, { unread: number; maxId: number }>();
  const replace = (rows: readonly RecipientUnread[]): void => {
    entries.clear();
    for (const row of rows) {
      if (row.unread > 0) entries.set(row.toTicketId, { unread: row.unread, maxId: row.maxId });
    }
  };
  const refreshTicket = (store: Store, ticketId: number): void => {
    const row = unreadForTicket(store, ticketId);
    if (row === null) entries.delete(ticketId);
    else entries.set(ticketId, { unread: row.unread, maxId: row.maxId });
  };
  return {
    get: (ticketId) => entries.get(ticketId)?.unread ?? 0,
    watermark: (ticketId) => entries.get(ticketId)?.maxId ?? 0,
    replace,
    refresh: (store, projectId) => replace(unreadByRecipient(store, projectId)),
    refreshTicket,
    clear: () => entries.clear(),
  };
}
