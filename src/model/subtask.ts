/**
 * Shared sub-task identity — the semantic fact and the compact text marker.
 *
 * A ticket is a sub-task when `tickets.subtask_parent_id` is set (design NDL-70
 * §3). That fact is relationship metadata, never part of the stored title.
 * Surfaces choose how to represent it: rich/icon-capable surfaces render their
 * own marker (the sidebar row's `⊂ <parentKey>` parentref), text-only surfaces
 * (editor tab titles, terminal names) FORCE `subtaskTextPrefix` — ONE character
 * of relationship identity — at their presentation seam, whatever any user
 * template says. It is never a template token, so a sub-task can't be configured
 * out of a name. Nothing here ever parses a title.
 *
 * The marker is deliberately NOT follow-up's `↳` (`model/followUp.ts`): the two
 * relations are orthogonal — a ticket can carry either, and a text-only surface
 * must be able to tell "continues after" from "is part of".
 *
 * vscode-free and pure.
 */

/** The single-character text marker for sub-task identity in text-only surfaces. */
export const SUBTASK_TEXT_MARKER = '⊂';

/** Whether a ticket is a sub-task — the domain fact, from `subtaskParentId`. */
export function isSubtask(ticket: { subtaskParentId: number | null }): boolean {
  return ticket.subtaskParentId !== null;
}

/**
 * Compact text prefix for a text-only surface: `'⊂ '` for a sub-task ticket,
 * `''` otherwise. Carries its own trailing space so a surface can prepend it
 * directly before its rendered label and a non-sub-task renders unchanged.
 */
export function subtaskTextPrefix(ticket: { subtaskParentId: number | null }): string {
  return isSubtask(ticket) ? `${SUBTASK_TEXT_MARKER} ` : '';
}

/** Prefix a rendered label with the one-char sub-task marker — the text-only seam. */
export function compactSubtaskLabel(
  ticket: { subtaskParentId: number | null },
  label: string,
): string {
  return `${subtaskTextPrefix(ticket)}${label}`;
}

/**
 * The compact parent reference a rich surface renders for a sub-task row:
 * `⊂ <parentKey>`. The SAME one-char marker as the text-only prefix — the
 * identity is the relation, not the surface — so a sub-task row and a sub-task
 * tab title agree on which relation they carry.
 */
export function subtaskParentRef(parentKey: string): string {
  return `${SUBTASK_TEXT_MARKER} ${parentKey}`;
}

/** How many of a parent's direct sub-tasks have reached the terminal `done` stage. */
export interface SubtaskProgress {
  done: number;
  total: number;
}

/**
 * Progress over a parent's direct sub-tasks, by their stored `stage_current`.
 * A parent with none reads `0/0`, which a surface renders as absence.
 */
export function subtaskProgress(
  subtasks: readonly { stageCurrent: string | null }[],
): SubtaskProgress {
  let done = 0;
  for (const s of subtasks) if (s.stageCurrent === 'done') done += 1;
  return { done, total: subtasks.length };
}

/**
 * Whether a ticket may still gain direct sub-tasks. Mirrors the writer's rule
 * (`workflow/stages/subtask.ts`): a shipping parent's branch is being merged
 * and a done parent is served by follow-ups, so neither may stack new
 * sub-tasks; an archived ticket is likewise out. Presentation derives from
 * this so the dashboard never offers an action the writer would refuse.
 */
export function canAddSubtask(parent: {
  stageCurrent: string | null;
  archivedAt: string | null;
}): boolean {
  return (
    parent.archivedAt === null && parent.stageCurrent !== 'ship' && parent.stageCurrent !== 'done'
  );
}
