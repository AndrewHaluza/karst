import type { Store } from './db.js';
import type { StageKey } from '../model/types.js';
import type { PostMessageInput } from './ticketMessages.js';
import { blockNotifiesParent } from '../model/blockerNotify.js';

/**
 * Sub-task events written AT THE SOURCE (v64 mailbox). The host never sees a
 * CLI-driven transition, so the event row is derived inside the single stage
 * writer (`setStage`) — the CLI and the host emit alike, in the same
 * transaction as the write that caused them.
 *
 * Exactly one row per occurrence: an event fires on the EDGE (done not yet
 * passed -> passed; no/different block -> this block), never on a re-patch of
 * the same state. Non-sub-tasks never produce a row.
 */

/** Bound on the block reason quoted into an event body. */
export const EVENT_REASON_MAX = 300;

/** The fields of a stage patch that can trigger an event. */
export interface EventPatch {
  status?: string;
  blockedKind?: string | null;
  blockedReason?: string | null;
}

interface SubtaskRow {
  key: string | null;
  project_id: number | null;
  subtask_parent_id: number | null;
}

interface PriorStageRow {
  status: string;
  blocked_kind: string | null;
}

/**
 * The event row a stage patch would emit, computed from the state BEFORE the
 * patch is applied — or null when it emits nothing.
 */
export function subtaskStageEvent(
  store: Store,
  ticketId: number,
  stageKey: StageKey,
  patch: EventPatch,
): PostMessageInput | null {
  const entersDone = stageKey === 'done' && patch.status === 'passed';
  const setsBlock =
    typeof patch.blockedKind === 'string' && blockNotifiesParent(patch.blockedKind);
  if (!entersDone && !setsBlock) return null;

  const ticket = store.db
    // Joined, not read raw: `subtask_parent_id` and `project_id` carry no FK,
    // so a dangling parent yields no event and a dangling project files the
    // event unscoped — a notification must never fail the stage write.
    .prepare(
      `SELECT c.key, pr.id AS project_id, p.id AS subtask_parent_id
         FROM tickets c
         JOIN tickets p ON p.id = c.subtask_parent_id
         LEFT JOIN projects pr ON pr.id = c.project_id
        WHERE c.id = ?`,
    )
    .get(ticketId) as SubtaskRow | undefined;
  if (!ticket || ticket.subtask_parent_id === null) return null;

  const prior = store.db
    .prepare('SELECT status, blocked_kind FROM stages WHERE ticket_id = ? AND stage_key = ?')
    .get(ticketId, stageKey) as PriorStageRow | undefined;
  if (!prior) return null;

  const body = eventBody(ticket.key ?? `#${ticketId}`, stageKey, patch, prior, entersDone);
  if (body === null) return null;
  return {
    projectId: ticket.project_id,
    fromTicketId: null,
    toTicketId: ticket.subtask_parent_id,
    kind: 'event',
    body,
  };
}

function eventBody(
  childKey: string,
  stageKey: StageKey,
  patch: EventPatch,
  prior: PriorStageRow,
  entersDone: boolean,
): string | null {
  if (entersDone && prior.status !== 'passed') return `${childKey} landed (done)`;
  if (
    typeof patch.blockedKind === 'string' &&
    blockNotifiesParent(patch.blockedKind) &&
    prior.blocked_kind !== patch.blockedKind
  ) {
    const reason = (patch.blockedReason ?? '').trim() || patch.blockedKind;
    // By code points, so a bound never splits a surrogate pair.
    const bounded = Array.from(reason).slice(0, EVENT_REASON_MAX).join('');
    return `${childKey} blocked at ${stageKey}: ${bounded}`;
  }
  return null;
}
