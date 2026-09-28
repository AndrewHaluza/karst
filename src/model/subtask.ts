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
