import { randomUUID } from 'node:crypto';
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
  operation_token: string | null;
  detach_token: string | null;
}

/**
 * A stored `kind` that is not one of the two known values degrades to 'image'
 * rather than throwing. This is a read path that runs on every panel repaint and
 * every context build; one unrecognized row must not take the surface down. The
 * writer is the authority and only ever stores a validated kind, so this guards
 * the boundary, not the writer — the same rule `mergeChecks.parseFiles` follows.
 */
function toKind(raw: string): AttachmentKind {
  return raw === 'video' ? 'video' : raw === 'file' ? 'file' : 'image';
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

export interface AttachmentWriteClaim {
  kind: 'claimed';
  row: AttachmentRow;
  token: string;
  /** Whether this claim created the row rather than reusing the canonical one. */
  inserted: boolean;
}

export interface AttachmentWriteBusy {
  kind: 'busy';
}

export type AttachmentWriteAttempt = AttachmentWriteClaim | AttachmentWriteBusy;
export type AttachmentWriteState = 'ready' | 'waiting-for-detach' | 'superseded' | 'missing';

const OPERATION_LEASE_MS = 5 * 60 * 1000;

function operationToken(kind: 'attach' | 'detach'): string {
  return `${kind}:${Date.now()}:${randomUUID()}`;
}

function isStaleOperationToken(token: string, now = Date.now()): boolean {
  const startedAt = Number(token.split(':')[1]);
  return Number.isFinite(startedAt) && now - startedAt > OPERATION_LEASE_MS;
}

/**
 * Atomically attach to a still-live ticket and claim the row while its caller
 * verifies publication. A pre-existing detach claim stays visible in the
 * separate `detach_token`; the detacher observes this attach token, cancels its
 * row deletion, and releases the handshake before publication is finalized.
 */
export function beginAttachmentWrite(
  store: Store,
  input: AttachmentInput,
): AttachmentWriteAttempt | null {
  const createdAt = new Date().toISOString();
  const token = operationToken('attach');
  const inserted = store.db
    .prepare(
      `INSERT INTO ticket_attachments
         (ticket_id, kind, stored_name, original_name, byte_size, created_at, operation_token)
       SELECT ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM tickets WHERE id = ?)
       ON CONFLICT(ticket_id, stored_name) DO NOTHING
       RETURNING *`,
    )
    .get(
      input.ticketId,
      input.kind,
      input.storedName,
      input.originalName,
      input.byteSize,
      createdAt,
      token,
      input.ticketId,
    ) as AttachmentDbRow | undefined;
  if (inserted) {
    return { kind: 'claimed', row: rowToAttachment(inserted), token, inserted: true };
  }

  const claimExisting = (priorToken: string | null): AttachmentDbRow | undefined =>
    store.db
      .prepare(
        `UPDATE ticket_attachments
         SET operation_token = ?
         WHERE ticket_id = ? AND stored_name = ?
           AND operation_token ${priorToken === null ? 'IS NULL' : '= ?'}
         RETURNING *`,
      )
      .get(
        token,
        input.ticketId,
        input.storedName,
        ...(priorToken === null ? [] : [priorToken]),
      ) as AttachmentDbRow | undefined;

  const unclaimed = claimExisting(null);
  if (unclaimed) {
    return { kind: 'claimed', row: rowToAttachment(unclaimed), token, inserted: false };
  }

  const current = store.db
    .prepare(`${SELECT} WHERE ticket_id = ? AND stored_name = ?`)
    .get(input.ticketId, input.storedName) as AttachmentDbRow | undefined;
  if (current) {
    if (
      current.operation_token !== null
      && isStaleOperationToken(current.operation_token)
    ) {
      const recovered = claimExisting(current.operation_token);
      if (recovered) {
        return { kind: 'claimed', row: rowToAttachment(recovered), token, inserted: false };
      }
    }
    return { kind: 'busy' };
  }

  const parent = store.db
    .prepare('SELECT 1 AS present FROM tickets WHERE id = ?')
    .get(input.ticketId) as { present: number } | undefined;
  return parent ? { kind: 'busy' } : null;
}

/**
 * Observe the cross-window handshake after beginning an attach. A pre-existing
 * detach retains `detach_token` until it has either removed or restored its
 * staged file; only then may this writer perform its final publication check.
 */
export function attachmentWriteState(
  store: Store,
  id: number,
  token: string,
): AttachmentWriteState {
  const row = store.db
    .prepare('SELECT operation_token, detach_token FROM ticket_attachments WHERE id = ?')
    .get(id) as Pick<AttachmentDbRow, 'operation_token' | 'detach_token'> | undefined;
  if (!row) return 'missing';
  if (row.operation_token !== token) return 'superseded';
  if (row.detach_token === null) return 'ready';
  if (isStaleOperationToken(row.detach_token)) {
    const recovered = store.db
      .prepare(
        `UPDATE ticket_attachments SET detach_token = NULL
         WHERE id = ? AND operation_token = ? AND detach_token = ?`,
      )
      .run(id, token, row.detach_token);
    if (recovered.changes > 0) return 'ready';
    return attachmentWriteState(store, id, token);
  }
  return 'waiting-for-detach';
}

/** Release a transient attach claim only when this caller still owns it. */
export function releaseAttachmentOperation(store: Store, id: number, token: string): void {
  store.db
    .prepare(
      'UPDATE ticket_attachments SET operation_token = NULL WHERE id = ? AND operation_token = ?',
    )
    .run(id, token);
}

/**
 * Roll back a publication claim without destroying a reused canonical row. A
 * newly inserted row has no earlier reference to preserve, so it is deleted;
 * a dedupe claim only releases ownership and leaves its retry metadata intact.
 * Caller precondition for an inserted claim: remove any published bytes first,
 * while operation_token still blocks another writer from claiming this row.
 */
export function abortAttachmentWrite(store: Store, claim: AttachmentWriteClaim): void {
  if (claim.inserted) {
    store.db
      .prepare('DELETE FROM ticket_attachments WHERE id = ? AND operation_token = ?')
      .run(claim.row.id, claim.token);
  } else {
    releaseAttachmentOperation(store, claim.row.id, claim.token);
  }
}

export type AttachmentWriteFinalization = 'attached' | 'superseded' | 'missing';

/**
 * Publish the DB side only when this writer still owns it. `missing` means a
 * hard delete cascaded the row while filesystem work was in flight; its caller
 * must remove any bytes it just published. A newer same-content attach owns a
 * `superseded` row and is responsible for completing publication.
 */
export function finalizeAttachmentWrite(
  store: Store,
  id: number,
  token: string,
): AttachmentWriteFinalization {
  const released = store.db
    .prepare(
      'UPDATE ticket_attachments SET operation_token = NULL WHERE id = ? AND operation_token = ?',
    )
    .run(id, token);
  if (released.changes > 0) return 'attached';
  const exists = store.db
    .prepare('SELECT 1 AS present FROM ticket_attachments WHERE id = ?')
    .get(id) as { present: number } | undefined;
  return exists ? 'superseded' : 'missing';
}

/**
 * Convenience insertion for store/fixture callers with no async publication
 * window. Production ingest holds the claim through its post-write check.
 */
export function insertAttachment(store: Store, input: AttachmentInput): AttachmentRow | null {
  const attempt = beginAttachmentWrite(store, input);
  if (!attempt) return null;
  if (attempt.kind === 'busy') {
    return findAttachmentByStoredName(store, input.ticketId, input.storedName);
  }
  releaseAttachmentOperation(store, attempt.row.id, attempt.token);
  return attempt.row;
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

export type AttachmentDetachDecision =
  | { row: AttachmentRow; needsUnlink: false }
  | { row: AttachmentRow; needsUnlink: true; token: string };

/**
 * Atomically prepare a scoped detach while preserving the last row until its
 * asynchronous unlink succeeds. When a legacy duplicate exists, delete this
 * reference inside the transaction and leave the shared file alone. Otherwise
 * retain the last row as a retry handle and tell the caller to unlink it first.
 */
export function prepareAttachmentDetach(
  store: Store,
  id: number,
  ticketId: number,
): AttachmentDetachDecision | null {
  const token = operationToken('detach');
  const decide = store.db.transaction((): AttachmentDetachDecision | null => {
    const dbRow = store.db
      .prepare(`${SELECT} WHERE id = ? AND ticket_id = ?`)
      .get(id, ticketId) as AttachmentDbRow | undefined;
    if (!dbRow) return null;
    if (dbRow.operation_token !== null) {
      if (!isStaleOperationToken(dbRow.operation_token)) return null;
      const recovered = store.db
        .prepare(
          'UPDATE ticket_attachments SET operation_token = NULL WHERE id = ? AND operation_token = ?',
        )
        .run(id, dbRow.operation_token);
      if (recovered.changes === 0) return null;
      dbRow.operation_token = null;
    }
    const row = rowToAttachment(dbRow);
    // A prior attempt may have removed the staged bytes and then hit a DB
    // failure. Reusing its token makes the row itself durable retry metadata;
    // stage/discard become no-ops and finalization can resume safely.
    if (dbRow.detach_token !== null) {
      return { row, needsUnlink: true, token: dbRow.detach_token };
    }
    const other = store.db
      .prepare(
        `SELECT 1 AS present FROM ticket_attachments
         WHERE ticket_id = ? AND stored_name = ? AND id <> ?
         LIMIT 1`,
      )
      .get(ticketId, row.storedName, id) as { present: number } | undefined;
    if (other) {
      store.db.prepare('DELETE FROM ticket_attachments WHERE id = ?').run(id);
      return { row, needsUnlink: false };
    }
    store.db
      .prepare(
        `UPDATE ticket_attachments
         SET detach_token = ?
         WHERE id = ? AND operation_token IS NULL AND detach_token IS NULL`,
      )
      .run(token, id);
    return { row, needsUnlink: true, token };
  });
  return decide();
}

export type AttachmentDetachFinalization = 'detached' | 'canceled' | 'missing';

/**
 * Delete only when this detach still owns the row and no attach is active. A
 * concurrent attach turns finalization into `canceled` and receives an explicit
 * handshake release; hard delete yields `missing`.
 */
export function finalizeAttachmentDetach(
  store: Store,
  id: number,
  token: string,
): AttachmentDetachFinalization {
  const finalize = store.db.transaction((): AttachmentDetachFinalization => {
    const deleted = store.db
      .prepare(
        `DELETE FROM ticket_attachments
         WHERE id = ? AND detach_token = ? AND operation_token IS NULL`,
      )
      .run(id, token);
    if (deleted.changes > 0) return 'detached';
    const exists = store.db
      .prepare('SELECT 1 AS present FROM ticket_attachments WHERE id = ?')
      .get(id) as { present: number } | undefined;
    if (!exists) return 'missing';
    store.db
      .prepare('UPDATE ticket_attachments SET detach_token = NULL WHERE id = ? AND detach_token = ?')
      .run(id, token);
    return 'canceled';
  });
  return finalize();
}

/** Release a detach handshake after a filesystem failure, retaining the row. */
export function releaseAttachmentDetach(store: Store, id: number, token: string): void {
  store.db
    .prepare('UPDATE ticket_attachments SET detach_token = NULL WHERE id = ? AND detach_token = ?')
    .run(id, token);
}

/**
 * Delete one attachment row. Before unlinking, the caller must establish that
 * no other row for this ticket references the same stored name.
 */
export function deleteAttachment(store: Store, id: number): void {
  store.db.prepare('DELETE FROM ticket_attachments WHERE id = ?').run(id);
}
