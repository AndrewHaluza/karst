import type { Store } from '../store/db.js';
import { classifyStageEvent } from '../store/stageEvents.js';
import { isIntegrationParkReason, openGatingSubtasks } from './subtaskGate.js';

/**
 * Whether a sub-task event should wake its parent's agent (plan Wave 3).
 *
 * - `wake`: open the parent's session in the background;
 * - `skip`: TERMINAL — this row can never wake (not a wake event, parent
 *   missing/archived/graph, parent at ship/done); the caller claims it;
 * - `retry`: TRANSIENT — decide again on a later sweep (the caller bounds
 *   this by the event's age): parent not at impl yet, live here or elsewhere,
 *   integration in flight or parked (H1: never launch mid-integration),
 *   blocking children still open.
 *
 * Only `impl` wakes: a `fix` session needs the fix launcher's configured
 * assignment, which a generic open would not apply.
 */

export type WakeDecision = { decision: 'wake' | 'skip' | 'retry'; reason: string };

export interface ParentWakeProbe {
  isLiveHere: (ticketId: number) => boolean;
  /** Graph approach or graph surface — `openSession` would start a graph run. */
  isGraphTicket: (ticketId: number) => boolean;
  /** Integrate-and-release running for this parent (no park yet). */
  integrating: (ticketId: number) => boolean;
}

const TERMINAL_STAGES = new Set(['ship', 'done']);

interface ParentRow {
  stage_current: string | null;
  archived_at: string | null;
  agent_state: string | null;
}

const skip = (reason: string): WakeDecision => ({ decision: 'skip', reason });
const retry = (reason: string): WakeDecision => ({ decision: 'retry', reason });

function parkReasons(store: Store, parentId: number): Array<string | null> {
  const rows = store.db
    .prepare(`SELECT blocked_reason FROM stages WHERE ticket_id = ? AND blocked_kind = 'awaiting-subtask'`)
    .all(parentId) as { blocked_reason: string | null }[];
  return rows.map((r) => r.blocked_reason);
}

export function parentWakeDecision(
  store: Store,
  parentId: number,
  eventBody: string,
  probe: ParentWakeProbe,
): WakeDecision {
  const cls = classifyStageEvent(eventBody);
  if (cls === 'other') return skip('not a wake event');
  const parent = store.db
    .prepare('SELECT stage_current, archived_at, agent_state FROM tickets WHERE id = ?')
    .get(parentId) as ParentRow | undefined;
  if (!parent) return skip('parent missing');
  if (parent.archived_at !== null) return skip('parent archived');
  const stage = parent.stage_current ?? 'none';
  if (TERMINAL_STAGES.has(stage)) return skip(`parent at ${stage}`);
  if (probe.isGraphTicket(parentId)) return skip('graph ticket');
  if (stage !== 'impl') return retry(`parent at ${stage}`);
  if (probe.isLiveHere(parentId)) return retry('live here');
  if (parent.agent_state === 'running' || parent.agent_state === 'waiting') return retry('live elsewhere');
  if (probe.integrating(parentId)) return retry('integration in flight');
  const parks = parkReasons(store, parentId);
  if (cls === 'blocked' && parks.some(isIntegrationParkReason)) return retry('integration park present');
  if (cls === 'landed' && parks.length > 0) return retry('awaiting-subtask park present');
  if (cls === 'landed' && openGatingSubtasks(store, parentId, 'leave-impl').length > 0) {
    return retry('blocking sub-tasks still open');
  }
  return { decision: 'wake', reason: cls === 'blocked' ? 'child blocked' : 'last blocking child landed' };
}
