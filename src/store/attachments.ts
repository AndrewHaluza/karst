import type { AttachmentKind } from '../attachments/kinds.js';
import type { Store } from './db.js';

/**
 * The index of a ticket's prompt attachments. Rows only — the bytes live on disk
 * under `<globalStorage>/attachments/<ticketId>/<storedName>`.
 *
 * Driver-agnostic on purpose: the `karst context` CLI reads this table over
 * `node:sqlite`, so every statement here uses positional `?` placeholders and
 * `prepare().get/all/run` only. No named parameters, no `.pluck()`.
 */

export interface AttachmentRow {
  id: number;
  ticketId: number;
  kind: AttachmentKind;
  /** `<sha256[0..16]>.<ext>` — the on-disk filename. */
  storedName: string;
  /** What the user called it. Display only; never a path component. */
  originalName: string;
  byteSize: number;
  createdAt: string;
}

export interface AttachmentInput {
  ticketId: number;
  kind: AttachmentKind;
  storedName: string;
  originalName: string;
  byteSize: number;
}

interface AttachmentDbRow {
  id: number;
  ticket_id: number;
  kind: string;
  stored_name: string;
  original_name: string;
  byte_size: number;
  created_at: string;
}

/**
 * A stored `kind` that is not one of the two known values degrades to 'image'
 * rather than throwing. This is a read path that runs on every panel repaint and
 * every context build; one unrecognized row must not take the surface down. The
 * writer is the authority and only ever stores a validated kind, so this guards
 * the boundary, not the writer — the same rule `mergeChecks.parseFiles` follows.
 */
function toKind(raw: string): AttachmentKind {
  return raw === 'video' ? 'video' : 'image';
}

function rowToAttachment(row: AttachmentDbRow): AttachmentRow {
  return {
    id: row.id,
    ticketId: row.ticket_id,
    kind: toKind(row.kind),
    storedName: row.stored_name,
    originalName: row.original_name,
    byteSize: row.byte_size,
    createdAt: row.created_at,
  };
}

const SELECT = 'SELECT * FROM ticket_attachments';

/** One ticket's attachments, oldest first (insertion order). */
export function listAttachments(store: Store, ticketId: number): AttachmentRow[] {
  const rows = store.db
    .prepare(`${SELECT} WHERE ticket_id = ? ORDER BY id ASC`)
    .all(ticketId) as AttachmentDbRow[];
  return rows.map(rowToAttachment);
}

/** Insert one attachment and return the stored row. */
export function insertAttachment(store: Store, input: AttachmentInput): AttachmentRow {
  const createdAt = new Date().toISOString();
  const info = store.db
    .prepare(
      `INSERT INTO ticket_attachments
         (ticket_id, kind, stored_name, original_name, byte_size, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.ticketId,
      input.kind,
      input.storedName,
      input.originalName,
      input.byteSize,
      createdAt,
    );
  return {
    id: Number(info.lastInsertRowid),
    ticketId: input.ticketId,
    kind: input.kind,
    storedName: input.storedName,
    originalName: input.originalName,
    byteSize: input.byteSize,
    createdAt,
  };
}

/**
 * The row for `storedName` on this ticket, or null. Scoped to the ticket, not
 * global: the same bytes attached to two tickets are two files in two
 * directories, so a dedupe hit must never cross a ticket boundary.
 */
export function findAttachmentByStoredName(
  store: Store,
  ticketId: number,
  storedName: string,
): AttachmentRow | null {
  const row = store.db
    .prepare(`${SELECT} WHERE ticket_id = ? AND stored_name = ?`)
    .get(ticketId, storedName) as AttachmentDbRow | undefined;
  return row ? rowToAttachment(row) : null;
}

/** One attachment by id, or null when it does not exist. */
export function getAttachment(store: Store, id: number): AttachmentRow | null {
  const row = store.db.prepare(`${SELECT} WHERE id = ?`).get(id) as AttachmentDbRow | undefined;
  return row ? rowToAttachment(row) : null;
}

/** Delete one attachment row. The caller unlinks the file. */
export function deleteAttachment(store: Store, id: number): void {
  store.db.prepare('DELETE FROM ticket_attachments WHERE id = ?').run(id);
}
