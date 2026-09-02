import type { Store } from '../store/db.js';
import type { StageKey } from '../model/types.js';
import { getTicket } from '../store/tickets.js';
import { getStage, setStage } from '../store/stages.js';
import { nowIso } from '../model/time.js';

/**
 * The dashboard-only "Reset stage" recovery action (Issue #3).
 *
 * A sibling of `sendBackToImplement` — NOT reachable from the agent CLI, never
 * a verdict edge on the graph. When a gate stage (uat/review) has exhausted its
 * recovery-round budget and the ticket rests at `fix` for a human, this action
 * clears the stage row, marks its recovery rounds `reset` (which ends the
 * episode per T1B), and moves the ticket back to the gate stage so the gates
 * re-run cleanly. The human's equivalent was three raw `UPDATE` statements
 * against the live registry — the only remedy before this path existed.
 *
 * `reset` is a terminal recovery-round status: the round stays as history
 * (append-only) but is excluded from the active series, and the episode it
 * ended means the next failure opens a fresh episode at round 1 (T1B). A
 * `reset` round is NOT `passed` — the fix did not land — so it does not
 * falsely advance the ticket.
 */

/** The gate stages whose exhaustion this action recovers. */
const RESETTABLE_GATES: readonly StageKey[] = ['uat', 'review'] as const;

/** Why the recovery action is not being offered right now. */
export type ResetStageUnavailableReason = 'stage' | 'in-flight';

/** The host's verdict on offering the action, mirroring `sendBackState`'s shape. */
export type ResetStageState =
  | { available: true; stage: StageKey }
  | { available: false; reason: ResetStageUnavailableReason };

/**
 * Which gate stage to reset — the one that is `failed` (the stage that sent the
 * ticket to `fix`). Returns null if neither uat nor review is failed.
 */
function failedGate(
  uat: { status: string } | null,
  review: { status: string } | null,
): StageKey | null {
  if (uat?.status === 'failed') return 'uat';
  if (review?.status === 'failed') return 'review';
  return null;
}

/**
 * Whether the recovery action may be offered for the ticket RIGHT NOW.
 *
 * Refuses when:
 *  - neither uat nor review is `failed` (`stage`) — the action exists to clear
 *    a failed gate stage, and a stage that passed or never ran has nothing to
 *    reset;
 *  - the failed gate has a fix execution in flight (`in-flight`) — mutating the
 *    ticket underneath a running fix would race the driver. "In flight" is a
 *    `fixing` recovery round (the agent is actively fixing). A pending or
 *    interrupted round is NOT in flight — the agent is not working.
 *
 * Pure over the store, exactly like `sendBackState`, so the whole decision is
 * testable against an in-memory DB.
 */
export function resetStageState(store: Store, ticketId: number): ResetStageState {
  const ticket = getTicket(store, ticketId);
  const uat = getStage(store, ticketId, 'uat');
  const review = getStage(store, ticketId, 'review');
  const stage = failedGate(uat, review);
  if (stage === null) return { available: false, reason: 'stage' };

  // A fixing round means the agent is actively working — do not reset underneath it.
  const fixing = store.db
    .prepare(
      `SELECT 1 FROM recovery_rounds
        WHERE ticket_id = ? AND source_stage = ? AND status = 'fixing' LIMIT 1`,
    )
    .get(ticketId, stage) !== undefined;
  if (fixing) return { available: false, reason: 'in-flight' };

  return { available: true, stage };
}

/** What the recovery mutation returns: the stage that was reset. */
export interface ResetStageResult {
  stage: StageKey;
}

/**
 * Reset the failed gate stage and move the ticket back to it.
 *
 * This is the dedicated mutation — it never calls `transition`, never consumes
 * or bumps a stage attempt, and never authors a verdict. The availability
 * checks are re-run INSIDE the transaction, against the same store it mutates,
 * so a ticket a sweep or a teammate's merge moved between the click and this
 * call is refused rather than mutated underneath its new state.
 *
 * The mutation is one atomic write over `stages` + `tickets.stage_current` +
 * `recovery_rounds`:
 *  - the failed gate stage is reset to `pending` (has not run yet), then
 *    re-entered `running` the way the machine enters a gate stage, with a real
 *    `startedAt` so `deriveStageCurrent` does not skip it on the next reload
 *    (the bug a naive `pending`-only reset would reintroduce — reconcile.ts:53
 *    skips a pending stage with `startedAt === null`);
 *  - the fix stage row is reset to `pending` (no longer parked/failed);
 *  - every open recovery round for the gate is marked `reset` — terminal, ends
 *    the episode (T1B), excluded from the active series.
 *
 * Append-only evidence (`gate_runs`, `review_findings`, `uat_findings`,
 * `stage_runs`) is untouched: the reset clears CURRENT state, never history.
 */
export function resetGateStage(
  store: Store,
  ticketId: number,
  opts?: {
    now?: () => string;
    /** Verbose decision-point logging (§ debug logging), prefixed `[reset-stage]`. */
    debug?: (message: string) => void;
  },
): ResetStageResult {
  const at = (opts?.now ?? nowIso)();
  let stage: StageKey = 'uat';
  const apply = store.db.transaction(() => {
    const state = resetStageState(store, ticketId);
    if (!state.available) {
      opts?.debug?.(
        `[reset-stage] ticket ${ticketId}: refused — ${state.reason} (no mutation)`,
      );
      throw new Error(`reset stage refused: ticket ${ticketId} is not recoverable (${state.reason})`);
    }
    stage = state.stage;
    opts?.debug?.(
      `[reset-stage] ticket ${ticketId}: resetting '${stage}' ` +
        `(recovery rounds marked reset, episode ended; ticket moves back to '${stage}')`,
    );

    // Reset the failed gate stage to a clean slate, then re-enter it `running`
    // with a real startedAt so deriveStageCurrent does not skip it on reload.
    setStage(store, ticketId, stage, {
      status: 'pending',
      verdict: null,
      attempt: 0,
      artifactPath: null,
      startedAt: null,
      endedAt: null,
      blockedKind: null,
      blockedReason: null,
      blockedAt: null,
    });
    setStage(store, ticketId, stage, {
      status: 'running',
      startedAt: at,
    });

    // Reset the fix stage row — no longer parked/failed.
    setStage(store, ticketId, 'fix', {
      status: 'pending',
      verdict: null,
      attempt: 0,
      artifactPath: null,
      startedAt: null,
      endedAt: null,
      blockedKind: null,
      blockedReason: null,
      blockedAt: null,
    });

    // Mark every non-terminal recovery round for this gate as `reset`. Only
    // active rounds (pending/fixing/revalidating) need closing — a terminal
    // round (passed/failed/exhausted/interrupted/refused) is already history.
    // An `exhausted` round is terminal, but the episode must still end, so we
    // also mark exhausted rounds `reset` — the status that ends the episode.
    store.db
      .prepare(
        `UPDATE recovery_rounds
           SET status = 'reset', ended_at = ?
         WHERE ticket_id = ? AND source_stage = ?
           AND status IN ('pending','fixing','revalidating','exhausted')`,
      )
      .run(at, ticketId, stage);

    // Move the ticket back to the gate stage.
    store.db
      .prepare('UPDATE tickets SET stage_current = ?, agent_state = ? WHERE id = ?')
      .run(stage, 'idle', ticketId);
  });
  apply();
  return { stage };
}