import type { Store } from './db.js';

/**
 * Project-wide gate slots (v99), the memory-queue claim pattern (`store/memoryQueue.ts`, arch:AUTOSTART) applied to
 * sandbox gate runs. A row is one running gate. Acquire is ONE `INSERT … WHERE count < limit` statement, so two windows
 * can never both take the last slot. A running gate refreshes `touched_at`; a row nobody refreshed belongs to a dead
 * window and is reaped (the stale-claim requeue: its slot becomes free for a waiter).
 */
export const GATE_SLOT_HEARTBEAT_MS = 30_000;
/** A slot not refreshed for this long belongs to a gate whose window died. */
export const STALE_GATE_SLOT_MS = 2 * 60_000;

const NOW_MS = "strftime('%Y-%m-%d %H:%M:%f', 'now')";

/** Take a slot if fewer than `limit` are held in the project. Returns the slot id, or null when full. `limit` 0 is unlimited and takes no row. */
export function acquireGateSlot(store: Store, input: { ticketId: number; projectId: number | null; owner: string; limit: number }): number | null {
  if (input.limit === 0) return null;
  const info = store.db
    .prepare(
      `INSERT INTO gate_slots (ticket_id, project_id, owner, claimed_at, touched_at)
       SELECT @ticket, @project, @owner, ${NOW_MS}, ${NOW_MS}
        WHERE (SELECT COUNT(*) FROM gate_slots WHERE project_id IS @project) < @limit`,
    )
    .run({ ticket: input.ticketId, project: input.projectId, owner: input.owner, limit: input.limit });
  return info.changes === 1 ? Number(info.lastInsertRowid) : null;
}

/** Free a slot: on every gate outcome (verdict, cancel, crash). Idempotent. */
export function releaseGateSlot(store: Store, slotId: number): void {
  store.db.prepare('DELETE FROM gate_slots WHERE id = ?').run(slotId);
}

/** Refresh a held slot so it is not reaped. False when the slot was already reaped. */
export function touchGateSlot(store: Store, slotId: number): boolean {
  return store.db.prepare(`UPDATE gate_slots SET touched_at = ${NOW_MS} WHERE id = ?`).run(slotId).changes === 1;
}

/** Delete slots not refreshed for `staleMs` (their window died). Returns the count. */
export function reapStaleGateSlots(store: Store, staleMs: number, projectId: number | null): number {
  return store.db
    .prepare(`DELETE FROM gate_slots WHERE project_id IS @project AND touched_at < strftime('%Y-%m-%d %H:%M:%f', 'now', @age)`)
    .run({ project: projectId, age: `-${staleMs / 1000} seconds` }).changes;
}

/** How many gates hold a slot in the project. */
export function countGateSlots(store: Store, projectId: number | null): number {
  return (store.db.prepare('SELECT COUNT(*) AS n FROM gate_slots WHERE project_id IS ?').get(projectId) as { n: number }).n;
}
