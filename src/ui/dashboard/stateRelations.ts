import { getProposalForTicket } from '../../store/planningProposals.js';
import { listRecoveryRounds } from '../../store/recoveryRounds.js';
import { listFixDeliveriesByRound } from '../../store/fixDeliveries.js';
import type { RoundWithDelivery } from '../../model/inside/recovery.js';
import type { Store } from '../../store/db.js';
import { getTicket, listSubtasks } from '../../store/tickets.js';
import { listOpenBlockers } from '../../store/ticketRelations.js';
import { isFinishedStage } from '../../model/types.js';
import { stageBadge } from '../../model/stageBadge.js';
import { stageColorClass } from '../../model/stagePalette.js';
import { subtaskAutostartPhase } from '../../model/subtask.js';
import { formatId, formatTicketRef } from '../../model/entityId.js';
import type { DashboardSubtaskRow } from './stateTypes.js';

/**
 * The ticket's relations: follow-up parent, sub-task parent, direct sub-tasks
 * and open blockers, read in one fixed order for the dashboard snapshot.
 */
export function readRelations(store: Store, ticket: ReturnType<typeof getTicket>) {
  const ticketId = ticket.id;
  // The parent relationship for the dashboard's secondary metadata line. A
  // follow-up's identity is relationship metadata, never part of its title. A
  // hard-deleted parent degrades to null — same policy as ticketContext.
  let parent: { key: string; ref: string; title: string | null } | null = null;
  if (ticket.parentTicketId !== null) {
    try {
      const p = getTicket(store, ticket.parentTicketId);
      parent = { key: p.key ?? formatId('ticket', p.id), ref: formatTicketRef(p.id, p.key), title: p.title };
    } catch {
      parent = null;
    }
  }
  // The sub-task composition relation (design NDL-70 §3/§8) — orthogonal to the
  // follow-up relation above: `subtask_parent_id` says "is part of", while
  // `parent_ticket_id` says "continues after". A hard-deleted parent degrades
  // to null, the same policy as the follow-up line.
  let subtaskParent: { key: string; ref: string; title: string | null } | null = null;
  if (ticket.subtaskParentId !== null) {
    try {
      const p = getTicket(store, ticket.subtaskParentId);
      subtaskParent = { key: p.key ?? formatId('ticket', p.id), ref: formatTicketRef(p.id, p.key), title: p.title };
    } catch {
      subtaskParent = null;
    }
  }
  // Direct sub-tasks, oldest first, for the "Sub-tasks" section and its
  // `n/m done` progress. One row read per child powers its status glyph; the
  // sub-task count is small and bounded by the writer's depth/creation rules,
  // and the alternative — a second stage-status derivation — would drift from
  // the one `stageBadge` every other surface paints with.
  const subtaskList = listSubtasks(store, ticketId);
  // A keyless target's label already IS `T<n>` (buildBlockerLabel), so the id is
  // only added when the label doesn't lead with it.
  const blockers = listOpenBlockers(store, ticketId).map((b) => {
    const id = b.targetTicketId === null ? null : formatId('ticket', b.targetTicketId);
    return { ticketId: b.targetTicketId, idLabel: id !== null && !b.label.startsWith(id) ? id : null, label: b.label };
  });
  const subtasks: DashboardSubtaskRow[] = subtaskList.map((s) => {
    const child = getTicket(store, s.id);
    const badge = stageBadge(child);
    return {
      id: s.id,
      idLabel: formatId('ticket', s.id),
      key: s.key ?? formatId('ticket', s.id),
      title: s.title,
      stage: s.stageCurrent,
      glyph: badge.glyph,
      stageClass: stageColorClass(badge.stage),
      blocking: s.blocksParent,
      done: isFinishedStage(s.stageCurrent),
      autostart: subtaskAutostartPhase(child),
    };
  });
  return { parent, subtaskParent, subtaskList, blockers, subtasks };
}

// Each round carries the receipt state of its stored fix brief (@arch:V77).
export function readRounds(store: Store, ticketId: number): RoundWithDelivery[] {
  const deliveries = listFixDeliveriesByRound(store, ticketId);
  return listRecoveryRounds(store, ticketId).map((round): RoundWithDelivery => {
    const delivery = deliveries.get(round.id);
    return delivery === undefined ? round : { ...round, fixDelivery: delivery };
  });
}

/** `from D88 (P17)` for a ticket filed from a planning draft; null otherwise. */
export function originLabel(store: Store, ticketId: number): string | null {
  const draft = getProposalForTicket(store, ticketId);
  if (!draft) return null;
  return `from ${formatId('draft', draft.id)} (${formatId('plan', draft.sessionId)})`;
}
