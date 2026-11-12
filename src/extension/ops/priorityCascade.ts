import type { Store } from '../../store/db.js';
import { readProjectQueue } from '../../store/queueItems.js';
import { getProposal, setProposalPriorityOverride } from '../../store/planningProposals.js';
import { getPlanningSession } from '../../store/planningSessions.js';
import { updateTicketFields } from '../../store/tickets.js';
import { parseId } from '../../model/entityId.js';
import { dependentsAbove, highestLevel, isHigherLevel } from '../../model/queueDependents.js';
import type { PriorityLevel } from '../../model/priority.js';
import { priorityRefusal } from './ticketPriorityOps.js';
import type { Notify } from './notify.js';

/**
 * After the user lowers a queue item, offer to lower the items that wait on it. Priority
 * inheritance (@arch:QUEUE-ORDER rule 1) raises the item again while a dependent keeps a
 * higher own level, so the lowered item would not move. The first change is already written
 * when the offer shows; Keep or a dismissed prompt leaves it as it is.
 */

export interface PriorityCascadeDeps {
  readonly store: Store;
  readonly projectId: () => number | undefined;
  readonly notify: Notify;
  readonly onChange: () => void;
  /** Rewrite the proposal index of a planning session after a draft changed. */
  readonly refreshIndex?: (sessionId: number) => void;
}

export const LOWER_ALL = 'Lower all';
export const KEEP = 'Keep';
/** The most ids the prompt names; the rest show as `+N`. */
export const MAX_LISTED_IDS = 5;

const label = (level: PriorityLevel): string => level.charAt(0).toUpperCase() + level.slice(1);

function listIds(ids: readonly string[]): string {
  const shown = ids.slice(0, MAX_LISTED_IDS).join(', ');
  return ids.length > MAX_LISTED_IDS ? `${shown} +${ids.length - MAX_LISTED_IDS}` : shown;
}

/** The own level of a queue item now; undefined when the item is not in the project queue. */
export function queueOwnLevel(deps: PriorityCascadeDeps, itemId: string): PriorityLevel | null | undefined {
  const projectId = deps.projectId();
  if (projectId === undefined) return undefined;
  return readProjectQueue(deps.store, projectId).entries.find((e) => e.id === itemId)?.ownPriority;
}

/** Write one dependent's override; false when the item changed since the walk and was skipped. */
function lowerOne(deps: PriorityCascadeDeps, id: string, level: PriorityLevel, sessions: Set<number>): boolean {
  const { kind, n } = parseId(id);
  if (kind === 'ticket') {
    if (priorityRefusal(deps.store, n, deps.projectId()) !== null) return false;
    updateTicketFields(deps.store, n, { priorityOverride: level });
    return true;
  }
  const p = getProposal(deps.store, n);
  if (p?.status !== 'pending') return false;
  if (getPlanningSession(deps.store, p.sessionId)?.projectId !== deps.projectId()) return false;
  setProposalPriorityOverride(deps.store, n, level);
  sessions.add(p.sessionId);
  return true;
}

/**
 * `before` is the own level of the item before the change (from `queueOwnLevel`). Nothing
 * happens unless the new own level is lower and a waiting item keeps a higher own level.
 */
export async function offerLowerDependents(
  deps: PriorityCascadeDeps,
  itemId: string,
  before: PriorityLevel | null | undefined,
): Promise<void> {
  const projectId = deps.projectId();
  if (before === undefined || projectId === undefined || !deps.notify.infoActions) return;
  const { entries } = readProjectQueue(deps.store, projectId);
  const self = entries.find((e) => e.id === itemId);
  if (!self || !isHigherLevel(before, self.ownPriority)) return;
  const level = self.ownPriority ?? 'normal';
  const ids = dependentsAbove(entries, itemId, level);
  if (ids.length === 0) return;

  const top = highestLevel(entries.filter((e) => ids.includes(e.id)).map((e) => e.ownPriority));
  const choice = await deps.notify.infoActions(
    `${itemId} is now ${label(level)}. ${listIds(ids)} wait on it at a higher level, so the queue keeps ${itemId} at ${label(top)}. Lower them to ${label(level)} too?`,
    [LOWER_ALL, KEEP],
  );
  if (choice !== LOWER_ALL) return;

  const sessions = new Set<number>();
  const skipped: string[] = [];
  for (const id of ids) {
    try {
      if (!lowerOne(deps, id, level, sessions)) skipped.push(id);
    } catch {
      skipped.push(id); // a write that raced with another change
    }
  }
  for (const sessionId of sessions) {
    try {
      deps.refreshIndex?.(sessionId);
    } catch {
      // The index is a convenience; a failed refresh never undoes a committed write.
    }
  }
  deps.onChange();
  if (skipped.length > 0) {
    deps.notify.warn(`${listIds(skipped)} changed in the meantime and stayed at their level.`);
  }
}
