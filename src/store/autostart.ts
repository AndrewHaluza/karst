import type { Store } from './db.js';

/**
 * Sub-task autostart state machine (plan §A, v64). `tickets.autostart_pending`:
 *
 *   0 none — 1 queued (at scope) — 2 starting (claimed by one sweep)
 *
 * - queue: 0 → 1, only at `scope` (`queueAutostart`, or the creating INSERT).
 * - claim: 1 → 2 in ONE statement guarded by the caps (`claimAutostart`), so
 *   overlapping sweeps and windows can never overshoot them.
 * - leaving scope: → 0 in `setStage` when the scope stage passes (single writer).
 * - failed start before scope passed: 2 → 0 (`releaseAutostart`). No retry —
 *   the user starts it manually; the failure is reported as an event.
 * - orphan (window died mid-start): a 2 still at scope with a stale
 *   `autostart_claimed_at` is re-queued to 1 (`requeueStaleClaims`).
 */

export const AUTOSTART_NONE = 0;
export const AUTOSTART_QUEUED = 1;
export const AUTOSTART_STARTING = 2;

/** Stages in which a sub-task holds a concurrency slot (besides a claim). */
export const SLOT_STAGES = ['impl', 'fix', 'uat', 'review'] as const;

export const SLOT_STAGES_SQL = `(${SLOT_STAGES.map((s) => `'${s}'`).join(', ')})`;

/** SQL predicate (alias `s`) for "this sub-task row holds a slot". */
export const HOLDS_SLOT_SQL = `s.archived_at IS NULL AND (s.stage_current IN ${SLOT_STAGES_SQL} OR s.autostart_pending = ${AUTOSTART_STARTING})`;

export interface AutostartCaps {
  /** Max slots per parent's direct children; 0 = unlimited. */
  perParent: number;
  /** Max sub-task slots project-wide (nested included); 0 = unlimited. */
  total: number;
}

/**
 * Claim a queued sub-task for starting: 1 → 2 with `claimed_at`, in one
 * statement whose WHERE re-checks both caps and blocks against the live rows. Returns
 * whether THIS caller won (exactly one caller can).
 */
export function claimAutostart(store: Store, ticketId: number, caps: AutostartCaps): boolean {
  const info = store.db
    .prepare(
      `UPDATE tickets
          SET autostart_pending = ${AUTOSTART_STARTING},
              autostart_claimed_at = datetime('now'), updated_at = datetime('now')
        WHERE id = @id AND autostart_pending = ${AUTOSTART_QUEUED}
          AND stage_current = 'scope' AND archived_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM ticket_relations r
            LEFT JOIN tickets t ON t.id = r.target_ticket_id
            WHERE r.ticket_id = @id AND r.kind = 'blocked-by'
              AND (r.target_ticket_id IS NULL OR (t.stage_current IS NOT 'done' AND t.archived_at IS NULL))
          )
          AND (@perParent <= 0 OR (SELECT COUNT(*) FROM tickets s
                WHERE s.subtask_parent_id = tickets.subtask_parent_id AND ${HOLDS_SLOT_SQL}) < @perParent)
          AND (@total <= 0 OR (SELECT COUNT(*) FROM tickets s
                WHERE s.project_id IS tickets.project_id AND s.subtask_parent_id IS NOT NULL
                  AND ${HOLDS_SLOT_SQL}) < @total)`,
    )
    .run({ id: ticketId, perParent: caps.perParent, total: caps.total });
  return info.changes === 1;
}

/** Failed start before scope passed: 2 → 0 (un-queued; started manually). */
export function releaseAutostart(store: Store, ticketId: number): void {
  store.db
    .prepare(
      `UPDATE tickets SET autostart_pending = ${AUTOSTART_NONE}, autostart_claimed_at = NULL,
              updated_at = datetime('now')
        WHERE id = ? AND autostart_pending = ${AUTOSTART_STARTING}`,
    )
    .run(ticketId);
}

/** Queue a sub-task at scope: 0 → 1 only. Never touches a starting claim. */
export function queueAutostart(store: Store, ticketId: number): boolean {
  const info = store.db
    .prepare(
      `UPDATE tickets SET autostart_pending = ${AUTOSTART_QUEUED}, updated_at = datetime('now')
        WHERE id = ? AND autostart_pending = ${AUTOSTART_NONE} AND stage_current = 'scope'
          AND archived_at IS NULL`,
    )
    .run(ticketId);
  return info.changes === 1;
}

/**
 * Re-queue orphaned claims: a starting (2) ticket still at scope whose claim is
 * older than `staleMs` belongs to a window that died mid-start. Returns count.
 */
export function requeueStaleClaims(store: Store, projectId: number, staleMs: number): number {
  const info = store.db
    .prepare(
      `UPDATE tickets SET autostart_pending = ${AUTOSTART_QUEUED}, autostart_claimed_at = NULL,
              updated_at = datetime('now')
        WHERE project_id = ? AND autostart_pending = ${AUTOSTART_STARTING}
          AND stage_current = 'scope'
          AND (autostart_claimed_at IS NULL OR autostart_claimed_at < datetime('now', ?))`,
    )
    .run(projectId, `-${Math.floor(staleMs / 1000)} seconds`);
  return info.changes;
}

/** Leaving scope ends the autostart lifecycle (called by `setStage`). */
export function clearAutostartOnScopePass(store: Store, ticketId: number): void {
  store.db
    .prepare(
      `UPDATE tickets SET autostart_pending = ${AUTOSTART_NONE}, autostart_claimed_at = NULL
        WHERE id = ? AND autostart_pending <> ${AUTOSTART_NONE}`,
    )
    .run(ticketId);
}
