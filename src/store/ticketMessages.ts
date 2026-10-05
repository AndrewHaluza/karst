import type { Store } from './db.js';

/**
 * The parent<->child mailbox (v64). Plain store functions over the shared
 * `Store` surface (`prepare(...).run/get/all`), so the same code serves the
 * extension's better-sqlite3 store and the CLI's node:sqlite shim.
 *
 * Bodies are untrusted text: stored verbatim (after trimming), never
 * interpreted. Who may address whom is a separate, pure rule — not here.
 */

/** Hard cap on a message body, measured after trimming. */
export const MAX_MESSAGE_BODY = 4096;

export type TicketMessageKind = 'message' | 'event';

const KINDS: readonly TicketMessageKind[] = ['message', 'event'];

/** Bind-parameter chunk for `markRead`, well under SQLite's variable limit. */
const MARK_READ_CHUNK = 500;

function isKind(value: unknown): value is TicketMessageKind {
  return typeof value === 'string' && (KINDS as readonly string[]).includes(value);
}

export interface TicketMessage {
  id: number;
  projectId: number | null;
  /** `null` = a host event (no agent sender). */
  fromTicketId: number | null;
  toTicketId: number;
  kind: TicketMessageKind;
  body: string;
  createdAt: string;
  readAt: string | null;
}

export interface PostMessageInput {
  projectId: number | null;
  fromTicketId: number | null;
  toTicketId: number;
  kind: TicketMessageKind;
  body: string;
}

interface MessageRow {
  id: number;
  project_id: number | null;
  from_ticket_id: number | null;
  to_ticket_id: number;
  kind: string;
  body: string;
  created_at: string;
  read_at: string | null;
}

function rowToMessage(r: MessageRow): TicketMessage {
  if (!isKind(r.kind)) throw new Error(`ticket_messages row ${r.id} has unknown kind '${r.kind}'`);
  return {
    id: Number(r.id),
    projectId: r.project_id === null ? null : Number(r.project_id),
    fromTicketId: r.from_ticket_id === null ? null : Number(r.from_ticket_id),
    toTicketId: Number(r.to_ticket_id),
    kind: r.kind,
    body: r.body,
    createdAt: r.created_at,
    readAt: r.read_at,
  };
}

/** Validate and normalize a body; throws a message naming the rule broken. */
function normalizeBody(body: string): string {
  const trimmed = body.trim();
  if (trimmed === '') throw new Error('message body is empty');
  if (trimmed.length > MAX_MESSAGE_BODY) {
    throw new Error(
      `message body is ${trimmed.length} chars; the limit is ${MAX_MESSAGE_BODY}`,
    );
  }
  return trimmed;
}

/** Insert one mailbox row and return it as stored. */
export function postMessage(store: Store, input: PostMessageInput): TicketMessage {
  if (!isKind(input.kind)) {
    throw new Error(`unknown message kind '${String(input.kind)}' (want message or event)`);
  }
  const body = normalizeBody(input.body);
  const info = store.db
    .prepare(
      `INSERT INTO ticket_messages (project_id, from_ticket_id, to_ticket_id, kind, body)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(input.projectId, input.fromTicketId, input.toTicketId, input.kind, body);
  const id = Number(info.lastInsertRowid);
  const row = store.db.prepare('SELECT * FROM ticket_messages WHERE id = ?').get(id) as
    | MessageRow
    | undefined;
  if (!row) throw new Error(`ticket_messages row ${id} vanished after insert`);
  return rowToMessage(row);
}

/** A ticket's inbox, oldest first (id order is insertion order). */
export function listInbox(
  store: Store,
  toTicketId: number,
  opts: { unreadOnly: boolean },
): TicketMessage[] {
  const unread = opts.unreadOnly ? ' AND read_at IS NULL' : '';
  const rows = store.db
    .prepare(`SELECT * FROM ticket_messages WHERE to_ticket_id = ?${unread} ORDER BY id`)
    .all(toTicketId) as MessageRow[];
  return rows.map(rowToMessage);
}

/** Mark rows read; already-read rows are untouched. Returns rows newly marked. */
export function markRead(store: Store, ids: readonly number[]): number {
  let marked = 0;
  for (let i = 0; i < ids.length; i += MARK_READ_CHUNK) {
    const chunk = ids.slice(i, i + MARK_READ_CHUNK);
    const placeholders = chunk.map(() => '?').join(', ');
    const info = store.db
      .prepare(
        `UPDATE ticket_messages SET read_at = datetime('now')
          WHERE read_at IS NULL AND id IN (${placeholders})`,
      )
      .run(...chunk);
    marked += Number(info.changes);
  }
  return marked;
}

/** Number of unread rows addressed to a ticket. */
export function unreadCount(store: Store, toTicketId: number): number {
  const row = store.db
    .prepare('SELECT COUNT(*) AS n FROM ticket_messages WHERE to_ticket_id = ? AND read_at IS NULL')
    .get(toTicketId) as { n: number };
  return Number(row.n);
}
