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
}

/** The highest mailbox row id, `0` when empty. */
export function maxMessageId(store: Store): number {
  const row = store.db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM ticket_messages').get() as {
    m: number;
  };
  return row.m;
}

/** Unread counts per recipient in one project, ordered by recipient id. */
export function unreadByRecipient(store: Store, projectId: number): RecipientUnread[] {
  return store.db
    .prepare(
      `SELECT to_ticket_id AS toTicketId, COUNT(*) AS unread, MAX(id) AS maxId
         FROM ticket_messages
        WHERE project_id = ? AND read_at IS NULL
        GROUP BY to_ticket_id
        ORDER BY to_ticket_id`,
    )
    .all(projectId) as RecipientUnread[];
}

/** Event rows in the project after `afterId` whose wake decision is not yet taken. */
export function pendingWakeEvents(store: Store, projectId: number, afterId: number): WakeEventRow[] {
  return store.db
    .prepare(
      `SELECT id, to_ticket_id AS toTicketId, body
         FROM ticket_messages
        WHERE project_id = ? AND kind = 'event' AND woke_at IS NULL AND id > ?
        ORDER BY id`,
    )
    .all(projectId, afterId) as WakeEventRow[];
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
