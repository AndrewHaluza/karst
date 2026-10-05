import type { Store } from '../store/db.js';
import { openGatingSubtasks } from './subtaskGate.js';
import { classifyStageEvent } from '../store/stageEvents.js';

/**
 * Whether a sub-task event should wake its parent's agent (plan Wave 3).
 *
 * - `wake`: open the parent's session in the background;
 * - `skip`: decided — no wake, ever, for this event row;
 * - `retry`: an `awaiting-subtask` park is on the parent (gate wait or
 *   integration in progress); decide again on a later sweep. H1: an agent is
 *   never launched mid-integration.
 *
 * Only a child "blocked" or a "landed" that leaves no open blocking child
 * wakes, and only a parent at impl/fix that is not archived, not graph-owned
 * and not live anywhere (here: the window's terminal; elsewhere: hook-driven
 * `agent_state` running/waiting).
 */

export type WakeDecision = { decision: 'wake' | 'skip' | 'retry'; reason: string };

export interface ParentWakeProbe {
  isLiveHere: (ticketId: number) => boolean;
  graphOwned: (ticketId: number) => boolean;
}

const WAKE_STAGES = new Set(['impl', 'fix']);

interface ParentRow {
  stage_current: string | null;
  archived_at: string | null;
  agent_state: string | null;
}

export function parentWakeDecision(
  store: Store,
  parentId: number,
  eventBody: string,
  probe: ParentWakeProbe,
): WakeDecision {
  const cls = classifyStageEvent(eventBody);
  if (cls === 'other') return { decision: 'skip', reason: 'not a wake event' };
  const parent = store.db
    .prepare('SELECT stage_current, archived_at, agent_state FROM tickets WHERE id = ?')
    .get(parentId) as ParentRow | undefined;
  if (!parent) return { decision: 'skip', reason: 'parent missing' };
  if (parent.archived_at !== null) return { decision: 'skip', reason: 'parent archived' };
  if (!WAKE_STAGES.has(parent.stage_current ?? '')) {
    return { decision: 'skip', reason: `parent at ${parent.stage_current ?? 'none'}` };
  }
  if (probe.graphOwned(parentId)) return { decision: 'skip', reason: 'graph-owned' };
  if (probe.isLiveHere(parentId)) return { decision: 'skip', reason: 'live here — pointer suffices' };
  if (parent.agent_state === 'running' || parent.agent_state === 'waiting') {
    return { decision: 'skip', reason: 'live elsewhere' };
  }
  const parked = store.db
    .prepare(`SELECT 1 FROM stages WHERE ticket_id = ? AND blocked_kind = 'awaiting-subtask' LIMIT 1`)
    .get(parentId);
  if (parked) return { decision: 'retry', reason: 'awaiting-subtask park present' };
  if (cls === 'landed' && openGatingSubtasks(store, parentId, 'leave-impl').length > 0) {
    return { decision: 'skip', reason: 'blocking sub-tasks still open' };
  }
  return { decision: 'wake', reason: cls === 'blocked' ? 'child blocked' : 'last blocking child landed' };
}
