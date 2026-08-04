import type { Store } from './db.js';
import type { BlockerKind, StageKey } from '../model/types.js';
import { setStage, stageAttempt } from './stages.js';
import { recordGateRun, type GateRunBatch } from './gateRuns.js';

/** A stage's persisted "karst could not ask" state. */
export interface StageBlock {
  kind: BlockerKind;
  reason: string;
  at: string;
}

export interface ParkGateStageInput {
  ticketId: number;
  stageKey: StageKey;
  kind: BlockerKind;
  reason: string;
  runAt: string;
  /** Whatever partial evidence exists. Empty is legitimate — nothing ran. */
  gates: GateRunBatch['gates'];
  /**
   * The run's log, when it wrote one. Set here rather than by a follow-up
   * `setStage` so the block, its evidence and the place to read that evidence
   * land in ONE transaction — a park is an outcome, and an outcome has one writer.
   */
  artifactPath?: string;
  /** v25: the invocation these gates belong to, when the caller opened one. */
  stageRunId?: number | null;
}

/**
 * Park a gate stage: record the evidence and the blocker in ONE transaction,
 * without transitioning and without touching `attempt`.
 *
 * Why not just throw and let the driver catch it: an exception is not a resting
 * place. `transition(null)` throws, the throw escapes to the host's catch, the
 * ticket is still at `uat`, and `ticketsToSweep` selects any ticket at a gate
 * stage — so the next window activation re-runs the whole failed stage to throw
 * in the same place, forever, across restarts, with no UI state to show for it.
 *
 * No attempt is consumed because nothing about the code was learned: the question
 * failed to be ASKED. Consuming one would spend the fix budget on a missing
 * script.
 *
 * This makes `gate_runs` a two-writer table — `transition`'s `premutate` and this
 * function. Both are transactional, both read `attempt` BEFORE any bump, so a
 * run is always filed under the attempt that ran.
 */
export function parkGateStage(store: Store, input: ParkGateStageInput): void {
  const apply = store.db.transaction(() => {
    if (input.gates.length > 0) {
      recordGateRun(store, {
        ticketId: input.ticketId,
        stageKey: input.stageKey,
        // Read before anything else touches the row. Nothing bumps it here, but
        // the ordering is the invariant, not the arithmetic.
        attempt: stageAttempt(store, input.ticketId, input.stageKey),
        runAt: input.runAt,
        gates: input.gates,
        stageRunId: input.stageRunId,
      });
    }
    setStage(store, input.ticketId, input.stageKey, {
      blockedKind: input.kind,
      blockedReason: input.reason,
      blockedAt: input.runAt,
      // Absent leaves the stored path alone (`setStage` skips undefined keys),
      // so a park that wrote no log never erases the last run's.
      artifactPath: input.artifactPath,
    });
  });
  apply();
}

/** The stage's current block, or null when it is not blocked. */
export function stageBlock(
  store: Store,
  ticketId: number,
  stageKey: StageKey,
): StageBlock | null {
  const row = store.db
    .prepare(
      'SELECT blocked_kind, blocked_reason, blocked_at FROM stages WHERE ticket_id = ? AND stage_key = ?',
    )
    .get(ticketId, stageKey) as
    | { blocked_kind: string | null; blocked_reason: string | null; blocked_at: string | null }
    | undefined;
  if (!row?.blocked_kind) return null;
  return {
    kind: row.blocked_kind as BlockerKind,
    reason: row.blocked_reason ?? '',
    at: row.blocked_at ?? '',
  };
}

/**
 * Clear a block — the explicit Resume path. A fresh run must also call this
 * before it starts, or a ticket that a human unblocked would keep its stale
 * blocker text on the row after passing.
 */
export function clearStageBlock(store: Store, ticketId: number, stageKey: StageKey): void {
  setStage(store, ticketId, stageKey, {
    blockedKind: null,
    blockedReason: null,
    blockedAt: null,
  });
}
