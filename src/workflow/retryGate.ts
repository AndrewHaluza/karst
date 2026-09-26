import type { Store } from '../store/db.js';
import type { StageKey } from '../model/types.js';
import { getStage, setStage } from '../store/stages.js';
import { stageBlock } from '../store/stageBlocks.js';
import { nowIso } from '../model/time.js';

/**
 * Whether a gate stage is eligible for a retry right now.
 *
 * Refuses when:
 *  - the ticket is not at uat/review — only gate stages are retryable
 *  - the stage is genuinely in-flight — must finish before retrying
 *  - the stage is not current (`stage_current`) — only the active stage can
 *    be retried
 *
 * A PARKED stage is not in-flight: `parkGateStage` records only the block and
 * leaves `status = 'running'` (a park is not a transition), so a bare status
 * check called every blocked gate in-flight and this control could never
 * enable. The block itself is the authoritative "parked, not running"
 * signal — only a running row WITHOUT one is genuinely mid-run.
 */
export type RetryGateState =
  | { available: true; stage: StageKey }
  | { available: false; reason: RetryGateUnavailableReason };

export type RetryGateUnavailableReason = 'not-gate-stage' | 'in-flight' | 'not-current';

const GATE_STAGES: readonly StageKey[] = ['uat', 'review'];

/** Whether a gate stage is mid-run rather than parked or resting. */
function isInFlight(store: Store, ticketId: number, stageKey: StageKey): boolean {
  return getStage(store, ticketId, stageKey)?.status === 'running'
    && stageBlock(store, ticketId, stageKey) === null;
}

export function retryGateState(store: Store, ticketId: number): RetryGateState {
  const ticket = store.db
    .prepare('SELECT stage_current FROM tickets WHERE id = ?')
    .get(ticketId) as { stage_current: string } | undefined;
  if (!ticket) return { available: false, reason: 'not-gate-stage' };
  const current = ticket.stage_current as StageKey;
  if (!GATE_STAGES.includes(current)) return { available: false, reason: 'not-gate-stage' };
  if (isInFlight(store, ticketId, current)) return { available: false, reason: 'in-flight' };
  return { available: true, stage: current };
}

/**
 * Reset a gate stage to `pending` so the driver re-runs it.
 *
 * This is a lighter recovery than "Send back to Implement": it does not touch
 * any other stage or move `stage_current`. The existing driver loop picks the
 * stage up on the next sweep, or the host can call `driveTicket` directly.
 *
 * Append-only evidence (`gate_runs`, `review_findings`, `uat_findings`,
 * `stage_runs`) is untouched — the retry appends new rows rather than
 * overwriting old ones.
 */
export function retryGateStage(
  store: Store,
  ticketId: number,
  stageKey: StageKey,
  opts?: { now?: () => string },
): { ok: boolean; reason?: string } {
  const now = opts?.now ?? nowIso;
  if (!GATE_STAGES.includes(stageKey)) {
    return { ok: false, reason: 'not a gate stage' };
  }
  const ticket = store.db
    .prepare('SELECT stage_current FROM tickets WHERE id = ?')
    .get(ticketId) as { stage_current: string } | undefined;
  if (!ticket) return { ok: false, reason: 'ticket not found' };
  if (ticket.stage_current !== stageKey) {
    return { ok: false, reason: 'stage is not current' };
  }
  if (isInFlight(store, ticketId, stageKey)) {
    return { ok: false, reason: 'stage is in-flight' };
  }

  setStage(store, ticketId, stageKey, {
    status: 'running',
    attempt: 0,
    verdict: null,
    artifactPath: null,
    startedAt: now(),
    endedAt: null,
    blockedKind: null,
    blockedReason: null,
    blockedAt: null,
  });

  return { ok: true };
}
