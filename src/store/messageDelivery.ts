import type { Store } from './db.js';

/**
 * Reads behind the mailbox delivery sweep (pointer nudges and parent wake).
 * Plain store functions over the shared `Store` surface.
 */

export interface RecipientUnread {
  toTicketId: number;
  unread: number;
  /** Highest unread row id — the delivery watermark candidate. */
  maxId: number;
}

export interface WakeEventRow {
  id: number;
  toTicketId: number;
  body: string;
  /** SQLite `datetime('now')` text (UTC, `YYYY-MM-DD HH:MM:SS`). */
  createdAt: string;
}

/** Default bound on one sweep's reads. */
export const DELIVERY_READ_LIMIT = 200;

/** The highest mailbox row id, `0` when empty. */
export function maxMessageId(store: Store): number {
  const row = store.db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM ticket_messages').get() as {
    m: number | bigint;
  };
  return Number(row.m);
}

/**
 * The unread entry for ONE recipient, `null` when it has no unread mail. The
 * reply path's per-turn top-up: `message send` is a separate CLI process, so
 * the host refreshes this ticket's count when its turn ends instead of waiting
 * for the next sweep.
 */
export function unreadForTicket(store: Store, toTicketId: number): RecipientUnread | null {
  const row = store.db
    .prepare(
      `SELECT COUNT(*) AS unread, COALESCE(MAX(id), 0) AS maxId
         FROM ticket_messages
        WHERE to_ticket_id = ? AND read_at IS NULL`,
    )
    .get(toTicketId) as { unread: number | bigint; maxId: number | bigint };
  const unread = Number(row.unread);
  if (unread <= 0) return null;
  return { toTicketId, unread, maxId: Number(row.maxId) };
}

/** Unread counts per recipient in one project, ordered by recipient id. */
export function unreadByRecipient(
  store: Store,
  projectId: number,
  limit = DELIVERY_READ_LIMIT,
): RecipientUnread[] {
  const rows = store.db
    .prepare(
      `SELECT to_ticket_id AS toTicketId, COUNT(*) AS unread, MAX(id) AS maxId
         FROM ticket_messages
        WHERE project_id = ? AND read_at IS NULL
        GROUP BY to_ticket_id
        ORDER BY to_ticket_id
        LIMIT ?`,
    )
    .all(projectId, limit) as Array<Record<keyof RecipientUnread, number | bigint>>;
  return rows.map((r) => ({ toTicketId: Number(r.toTicketId), unread: Number(r.unread), maxId: Number(r.maxId) }));
}

/** Event rows in the project after `afterId` whose wake decision is not yet taken. */
export function pendingWakeEvents(
  store: Store,
  projectId: number,
  afterId: number,
  limit = DELIVERY_READ_LIMIT,
): WakeEventRow[] {
  return store.db
    .prepare(
      `SELECT id, to_ticket_id AS toTicketId, body, created_at AS createdAt
         FROM ticket_messages
        WHERE project_id = ? AND kind = 'event' AND woke_at IS NULL AND id > ?
        ORDER BY id
        LIMIT ?`,
    )
    .all(projectId, afterId, limit) as WakeEventRow[];
}

/**
 * Atomically take the wake decision for one event row. Exactly one caller —
 * across windows sharing the DB — gets `true`.
 */
export function claimWake(store: Store, eventId: number): boolean {
  const info = store.db
    .prepare(`UPDATE ticket_messages SET woke_at = datetime('now') WHERE id = ? AND woke_at IS NULL`)
    .run(eventId);
  return Number(info.changes) === 1;
}
