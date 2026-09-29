import type { Store } from './db.js';

/**
 * Sub-task reads (NDL-75, design NDL-70 §4/§6). Kept here, beside the rest of
 * the store, so a workflow module never carries raw SQL against the ticket
 * tables (NDL-60's store-boundary rule). The writers live in `tickets.ts`
 * (`createSubtask`/`detachSubtaskParent`); these are the reads the integration
 * step needs.
 */

/** One landed sub-task, keyed for a block reason. */
export interface LandedSubtask {
  id: number;
  key: string;
}

/**
 * Every direct sub-task of `parentId` that has landed (`done`, not archived),
 * ordered by id. The presence of any row is what makes integration worth
 * attempting; the key names the sub-task in a refusal.
 */
export function listLandedSubtasks(store: Store, parentId: number): LandedSubtask[] {
  return store.db
    .prepare(
      `SELECT id, COALESCE(key, '#' || id) AS key
         FROM tickets
        WHERE subtask_parent_id = ?
          AND stage_current = 'done'
          AND archived_at IS NULL
        ORDER BY id`,
    )
    .all(parentId) as LandedSubtask[];
}

/**
 * The landed sub-tasks that STACKED on `parentBranch` in `repo` — a child whose
 * worktree was cut from the parent's branch for that same repository (NDL-72),
 * which is what the sub-task's ship pushes onto `origin/<parentBranch>`. A
 * landed child that never started (no worktree) or stacked on a different base
 * is not this repo's to integrate, and must not be named in its refusal.
 */
export function listLandedStackedSubtasks(
  store: Store,
  parentId: number,
  repo: string,
  parentBranch: string,
): LandedSubtask[] {
  return store.db
    .prepare(
      `SELECT DISTINCT t.id, COALESCE(t.key, '#' || t.id) AS key
         FROM tickets t
         INNER JOIN worktrees cw ON cw.ticket_id = t.id
        WHERE t.subtask_parent_id = ?
          AND t.stage_current = 'done'
          AND t.archived_at IS NULL
          AND cw.repo = ?
          AND cw.base_ref = ?
        ORDER BY t.id`,
    )
    .all(parentId, repo, parentBranch) as LandedSubtask[];
}

/**
 * Every ticket carrying an `awaiting-subtask` block, de-duplicated. Boot
 * reconciliation re-derives each one; integration runs first so a cleared block
 * never outruns the work it was holding for.
 */
export function listAwaitingSubtaskParentIds(store: Store): number[] {
  const rows = store.db
    .prepare(
      `SELECT DISTINCT ticket_id AS id FROM stages WHERE blocked_kind = 'awaiting-subtask'`,
    )
    .all() as { id: number }[];
  return rows.map((r) => r.id);
}
