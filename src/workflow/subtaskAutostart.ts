import type { Store } from '../store/db.js';

/**
 * Sub-task auto-start picker (plan §A). Read-only: decides which queued
 * sub-tasks may start now; the host op claims and starts them.
 *
 * A **slot** is a sub-task (direct child of some parent) whose stage is one of
 * `SLOT_STAGES` and that is not archived. `ship`/`done` free it. The per-parent
 * cap counts a parent's direct children in slots; the project-wide cap counts
 * every sub-task in a slot, nested ones included. `0` = unlimited.
 *
 * A parent must itself be past scope (in `SLOT_STAGES`) — before that its
 * branch may not exist and the child's base would fall back to a stale ref.
 */
export const SLOT_STAGES = ['impl', 'fix', 'uat', 'review'] as const;

export interface AutostartCaps {
  perParent: number;
  total: number;
}

export interface PickOptions extends AutostartCaps {
  /** Only parents whose live session this window owns; omitted = any parent. */
  ownedParentIds?: ReadonlySet<number>;
}

interface CandidateRow {
  id: number;
  parent_id: number;
}

const SLOT_IN = `(${SLOT_STAGES.map((s) => `'${s}'`).join(', ')})`;

function underCap(count: number, cap: number): boolean {
  return cap <= 0 || count < cap;
}

export function pickSubtasksToStart(store: Store, projectId: number, opts: PickOptions): number[] {
  const candidates = store.db
    .prepare(
      `SELECT c.id AS id, c.subtask_parent_id AS parent_id
         FROM tickets c JOIN tickets p ON p.id = c.subtask_parent_id
        WHERE c.project_id = ? AND c.autostart_pending = 1 AND c.stage_current = 'scope'
          AND c.archived_at IS NULL AND p.archived_at IS NULL
          AND p.stage_current IN ${SLOT_IN}
        ORDER BY COALESCE(c.blocks_parent, 0) DESC, c.id ASC`,
    )
    .all(projectId) as CandidateRow[];
  if (candidates.length === 0) return [];

  const slotRows = store.db
    .prepare(
      `SELECT subtask_parent_id AS parent_id, COUNT(*) AS n FROM tickets
        WHERE project_id = ? AND subtask_parent_id IS NOT NULL AND archived_at IS NULL
          AND stage_current IN ${SLOT_IN}
        GROUP BY subtask_parent_id`,
    )
    .all(projectId) as { parent_id: number; n: number }[];
  const perParent = new Map(slotRows.map((r) => [Number(r.parent_id), Number(r.n)]));
  let total = slotRows.reduce((sum, r) => sum + Number(r.n), 0);

  const picked: number[] = [];
  for (const c of candidates) {
    const parentId = Number(c.parent_id);
    if (opts.ownedParentIds && !opts.ownedParentIds.has(parentId)) continue;
    if (!underCap(total, opts.total)) break;
    const used = perParent.get(parentId) ?? 0;
    if (!underCap(used, opts.perParent)) continue;
    picked.push(Number(c.id));
    perParent.set(parentId, used + 1);
    total += 1;
  }
  return picked;
}
