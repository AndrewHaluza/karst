import type { Store } from './db.js';

/**
 * Host-memory wait queue (v97), modelled on the sub-task autostart tri-state (`store/autostart.ts`, arch:AUTOSTART).
 * `tickets.memory_wait`: 0 none — 1 queued (free host RAM below the threshold) — 2 starting (claimed by one sweep).
 *
 * - queue: any → 1 (`queueMemoryWait`), stamped for FIFO order; never touches a live claim.
 * - claim: 1 → 2 in ONE statement that also requires no EARLIER queued ticket (`claimMemoryWait`), so overlapping
 *   sweeps and windows can neither start the same ticket twice nor jump the line.
 * - done / failed / Cancel: → 0 (`clearMemoryWait`).
 * - orphan (window died mid-start): a stale 2 is re-queued to 1 (`requeueStaleMemoryClaims`).
 */
export const MEMORY_WAIT_NONE = 0;
export const MEMORY_WAIT_QUEUED = 1;
export const MEMORY_WAIT_STARTING = 2;

/** A starting claim older than this belongs to a window that died. */
export const STALE_MEMORY_CLAIM_MS = 5 * 60_000;

const NOW_MS = "strftime('%Y-%m-%d %H:%M:%f', 'now')";

/** Queue a ticket (or refresh the note of a queued one, keeping its place). False when it is mid-start or archived. */
export function queueMemoryWait(store: Store, ticketId: number, note: string, owner?: string): boolean {
  const info = store.db
    .prepare(
      `UPDATE tickets
          SET memory_wait_note = @note,
              memory_wait_owner = COALESCE(@owner, memory_wait_owner),
              memory_wait_at = CASE WHEN memory_wait = ${MEMORY_WAIT_QUEUED} THEN memory_wait_at ELSE ${NOW_MS} END,
              memory_wait = ${MEMORY_WAIT_QUEUED}, memory_claimed_at = NULL
        WHERE id = @id AND archived_at IS NULL AND memory_wait <> ${MEMORY_WAIT_STARTING}`,
    )
    .run({ id: ticketId, note, owner: owner ?? null });
  return info.changes === 1;
}

/** Claim the ticket for starting (1 → 2) only if it is first in line. Exactly one caller can win. */
export function claimMemoryWait(store: Store, ticketId: number): boolean {
  const info = store.db
    .prepare(
      `UPDATE tickets
          SET memory_wait = ${MEMORY_WAIT_STARTING}, memory_claimed_at = ${NOW_MS}
        WHERE id = @id AND memory_wait = ${MEMORY_WAIT_QUEUED} AND archived_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM tickets o
             WHERE o.memory_wait = ${MEMORY_WAIT_QUEUED} AND o.archived_at IS NULL AND o.id <> tickets.id AND o.project_id IS tickets.project_id
               AND (o.memory_wait_at < tickets.memory_wait_at OR (o.memory_wait_at = tickets.memory_wait_at AND o.id < tickets.id)))`,
    )
    .run({ id: ticketId });
  return info.changes === 1;
}

/** Claim a queued ticket (1 → 2) regardless of its place in line ('Start anyway'). False when it is not queued: a sweep or a click already took it. */
export function claimMemoryWaitNow(store: Store, ticketId: number): boolean {
  const info = store.db
    .prepare(`UPDATE tickets SET memory_wait = ${MEMORY_WAIT_STARTING}, memory_claimed_at = ${NOW_MS} WHERE id = ? AND memory_wait = ${MEMORY_WAIT_QUEUED} AND archived_at IS NULL`)
    .run(ticketId);
  return info.changes === 1;
}

/** Leave the queue from any state: started, failed, cancelled or archived. */
export function clearMemoryWait(store: Store, ticketId: number): void {
  store.db
    .prepare(`UPDATE tickets SET memory_wait = ${MEMORY_WAIT_NONE}, memory_wait_at = NULL, memory_claimed_at = NULL, memory_wait_note = NULL, memory_wait_owner = NULL WHERE id = ? AND memory_wait <> ${MEMORY_WAIT_NONE}`)
    .run(ticketId);
}

/** Re-queue claims older than `staleMs` (their window died mid-start), keeping their original place. Returns the count. */
export function requeueStaleMemoryClaims(store: Store, staleMs: number, projectId?: number): number {
  return store.db
    .prepare(
      `UPDATE tickets SET memory_wait = ${MEMORY_WAIT_QUEUED}, memory_claimed_at = NULL
        WHERE memory_wait = ${MEMORY_WAIT_STARTING} AND (@project IS NULL OR project_id = @project)
          AND (memory_claimed_at IS NULL OR memory_claimed_at < strftime('%Y-%m-%d %H:%M:%f', 'now', @age))`,
    )
    .run({ project: projectId ?? null, age: `-${Math.floor(staleMs / 1000)} seconds` }).changes;
}

/** Milliseconds a ticket has been queued, or null when it is not queued. */
export function memoryWaitAgeMs(store: Store, ticketId: number): number | null {
  const r = store.db
    .prepare(`SELECT CAST((julianday('now') - julianday(memory_wait_at)) * 86400000 AS INTEGER) AS age FROM tickets WHERE id = ? AND memory_wait <> ${MEMORY_WAIT_NONE} AND memory_wait_at IS NOT NULL`)
    .get(ticketId) as { age: number } | undefined;
  return r ? r.age : null;
}

/** The extension host that queued the ticket, or null (not queued, or queued before owners were recorded). */
export function memoryWaitOwner(store: Store, ticketId: number): string | null {
  const r = store.db.prepare('SELECT memory_wait_owner AS o FROM tickets WHERE id = ? AND memory_wait <> 0').get(ticketId) as { o: string | null } | undefined;
  return r?.o ?? null;
}

/** Queued ticket ids in FIFO order; with `projectId`, only that project's (a window never starts another project's ticket). */
export function listMemoryQueue(store: Store, projectId?: number): number[] {
  return (
    store.db
      .prepare(`SELECT id FROM tickets WHERE memory_wait = ${MEMORY_WAIT_QUEUED} AND archived_at IS NULL AND (@project IS NULL OR project_id = @project) ORDER BY memory_wait_at ASC, id ASC`)
      .all({ project: projectId ?? null }) as { id: number }[]
  ).map((r) => r.id);
}

/** The note a queued ticket shows ('Waiting for memory (free X GB, needs Y GB)'), or null when it is not waiting. */
export function memoryWaitNotes(store: Store): Map<number, string> {
  const rows = store.db
    .prepare(`SELECT id, memory_wait_note AS note FROM tickets WHERE memory_wait <> ${MEMORY_WAIT_NONE} AND archived_at IS NULL`)
    .all() as { id: number; note: string | null }[];
  return new Map(rows.map((r) => [r.id, r.note ?? 'Waiting for memory']));
}
