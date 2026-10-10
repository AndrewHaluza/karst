import type { Store } from './db.js';
import { STAGE_KEYS, type StageKey } from '../model/types.js';
import type { PostMessageInput } from './ticketMessages.js';
import { blockNotifiesParent } from '../model/blockerNotify.js';
import { formatId } from '../model/entityId.js';

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

const LANDED_SUFFIX = ' landed (done)';
const BLOCKED_INFIX = ' blocked at ';

/** The body of a child's "landed" event. */
export function landedEventBody(childKey: string): string {
  return `${childKey}${LANDED_SUFFIX}`;
}

/** The body of a child's "blocked" event (`reason` already bounded). */
export function blockedEventBody(childKey: string, stageKey: StageKey, reason: string): string {
  return `${childKey}${BLOCKED_INFIX}${stageKey}: ${reason}`;
}

export type StageEventClass = 'landed' | 'blocked' | 'other';

/**
 * Which builder wrote an event body. Keys carry no whitespace (the T<n> fallback is one token too — never a `T5 · KEY` ref here), so the first
 * token is the key; the reason (untrusted) only ever FOLLOWS the frame.
 */
export function classifyStageEvent(body: string): StageEventClass {
  const space = body.indexOf(' ');
  if (space <= 0) return 'other';
  const rest = body.slice(space);
  if (rest === LANDED_SUFFIX) return 'landed';
  if (rest.startsWith(BLOCKED_INFIX)) {
    const stage = rest.slice(BLOCKED_INFIX.length).split(':', 1)[0] ?? '';
    if ((STAGE_KEYS as readonly string[]).includes(stage) && rest.startsWith(`${BLOCKED_INFIX}${stage}: `)) {
      return 'blocked';
    }
  }
  return 'other';
}

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

  const body = eventBody(ticket.key ?? formatId('ticket', ticketId), stageKey, patch, prior, entersDone);
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
  if (entersDone && prior.status !== 'passed') return landedEventBody(childKey);
  if (
    typeof patch.blockedKind === 'string' &&
    blockNotifiesParent(patch.blockedKind) &&
    prior.blocked_kind !== patch.blockedKind
  ) {
    const reason = (patch.blockedReason ?? '').trim() || patch.blockedKind;
    // By code points, so a bound never splits a surrogate pair.
    const bounded = Array.from(reason).slice(0, EVENT_REASON_MAX).join('');
    return blockedEventBody(childKey, stageKey, bounded);
  }
  return null;
}
