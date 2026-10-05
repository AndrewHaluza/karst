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

/**
 * Whether a sub-task may be detached from its parent (design NDL-70 §5
 * 'Detach'). Mirrors the refusals the writer enforces
 * (`workflow/detachSubtask.ts`): only a NON-blocking, not-done sub-task with no
 * open sub-tasks of its own and no running agent may detach. A blocking child
 * is the parent's leave-impl gate, a done sub-task is already leaving the
 * stack, a child with open children would be rewritten out from under them, and
 * Karst never rewrites a tree under a live agent.
 *
 * `openChildren` is the count of this ticket's own non-archived direct
 * sub-tasks. Presentation derives from this so the dashboard never offers an
 * action the writer would refuse — same contract as `canAddSubtask`.
 */
export function canDetachSubtask(
  ticket: {
    subtaskParentId: number | null;
    blocksParent: boolean;
    stageCurrent: string | null;
    agentState: string | null;
  },
  openChildren: number,
): boolean {
  return (
    ticket.subtaskParentId !== null &&
    !ticket.blocksParent &&
    ticket.stageCurrent !== 'done' &&
    ticket.agentState !== 'running' &&
    openChildren === 0
  );
}

/** Where a sub-task is in the autostart lifecycle, as the UI names it. */
export type SubtaskAutostartPhase = 'queued' | 'starting';

interface AutostartFacts {
  subtaskParentId: number | null;
  autostartPending: boolean;
  autostartStarting: boolean;
  stageCurrent: string | null;
}

/**
 * The one derivation every surface renders (plan §A): `queued` while waiting
 * at `scope` for the sweep (`autostart_pending = 1`), `starting` once a sweep
 * claimed it (`= 2`), `null` otherwise — after scope it is an ordinary stage.
 */
export function subtaskAutostartPhase(ticket: AutostartFacts): SubtaskAutostartPhase | null {
  if (ticket.subtaskParentId === null || ticket.stageCurrent !== 'scope') return null;
  if (ticket.autostartStarting) return 'starting';
  return ticket.autostartPending ? 'queued' : null;
}

/** Waiting for the autostart sweep (`subtaskAutostartPhase` is `queued`). */
export function isQueuedSubtask(ticket: AutostartFacts): boolean {
  return subtaskAutostartPhase(ticket) === 'queued';
}
