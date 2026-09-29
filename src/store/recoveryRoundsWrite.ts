import type { Store } from './db.js';
import { openProcessRun, finishProcessRun, type ProcessRun } from './processRuns.js';
import {
  recordSessionLaunchIntent,
  confirmLaunchIntentRow,
  failSessionLaunchIntent,
  getSessionLaunchIntent,
  type ConfirmSessionLaunchIntentInput,
  type SessionLaunchIntent,
} from './sessionLaunchIntents.js';
import { setStage, stageAttempt } from './stages.js';
import {
  type RecoverySourceStage,
  type RecoveryTriggerKind,
  type RecoverySourceProcessId,
  type RecoveryRound,
  currentEpisode,
  activeRoundAnyStage,
  activeFixRound,
  roundById,
} from './recoveryRoundsRead.js';

/**
 * The karst-authored verdicts a PARKED fix stage row carries — the closed set
 * of "the fix is no longer in flight" reasons. Written by the interrupt/exhaust
 * paths and the driver's leave branches, read by the stepper's cell and the
 * Now line; never free-form prose, because these are the words the
 * dashboard repeats back to the user.
 */
export const FIX_PARKED_INTERRUPTED = 'fix session ended without the done marker';
export const FIX_PARKED_EXHAUSTED = 'fix attempts exhausted';
export const FIX_PARKED_NO_RESUMABLE_ROUND = 'fix parked — no resumable recovery round';
export const FIX_PARKED_NO_FAILED_GATE = 'fix parked — no failed gate to resume';
export const FIX_PARKED_PROCESS_UNAVAILABLE = 'fix process not available — parked for a human';
export const FIX_PARKED_NO_EXECUTION = 'fix parked — no fix execution in flight';
export const FIX_PARKED_STALLED =
  'fix stalled — no progress before the timeout; parked for a human';
/**
 * A fix launch was prepared but no SessionStart ever confirmed it, and the
 * launch window elapsed. Distinct from FIX_PARKED_NO_EXECUTION (a session that
 * opened and closed) and FIX_PARKED_STALLED (a live run that stopped making
 * progress): here the provider session never started at all.
 */
export const FIX_PARKED_LAUNCH_NEVER_STARTED =
  'fix launch never started — parked for a human';

/**
 * Re-stamp a RUNNING fix stage row as parked (`failed` + a bounded verdict +
 * endedAt). The machine's `entryPatch` enters fix `running`, and nothing ever
 * re-read it when a fix ended without the marker — so a ticket resting at fix
 * for a human kept claiming the agent was actively fixing, forever (the stuck
 * stage this closes). Every path that leaves the ticket at fix with no live
 * execution calls this.
 *
 * Strictly guarded, so it can never rewrite a truth:
 *  - the ticket must be AT `fix` (the machine wrote the row, and only it moves
 *    the ticket on — a `fix` row of a ticket that left is history);
 *  - the fix row must read `running` (a row the marker already passed is a
 *    finished fact; a row already parked keeps its first verdict — a second
 *    park with a different cause must never overwrite what the first said).
 *
 * Returns whether the row was actually re-stamped, so callers can report the
 * park instead of assuming it.
 */
export function parkFixStage(store: Store, ticketId: number, verdict: string, at: string): boolean {
  const current = store.db
    .prepare('SELECT stage_current FROM tickets WHERE id = ?')
    .get(ticketId) as { stage_current: string | null } | undefined;
  if (current === undefined || current.stage_current !== 'fix') return false;
  const row = store.db
    .prepare("SELECT status FROM stages WHERE ticket_id = ? AND stage_key = 'fix'")
    .get(ticketId) as { status: string } | undefined;
  if (row === undefined || row.status !== 'running') return false;
  setStage(store, ticketId, 'fix', { status: 'failed', verdict, endedAt: at });
  return true;
}

/**
 * The inverse of `parkFixStage`: re-stamp the fix row as live the moment a fix
 * execution actually begins (`beginLiveFixExecution` / `confirmFixLaunch`).
 * Normally a no-op — the machine already entered the row `running` — but a row
 * parked by an earlier sweep or session close must read `Fixing` again once a
 * real execution is attached to a pending round, or the headline would keep
 * saying "Fix failed" beside an agent that is actively working.
 */
function markFixStageLive(store: Store, ticketId: number): void {
  setStage(store, ticketId, 'fix', { status: 'running', verdict: null, endedAt: null });
}

export interface OpenRecoveryRoundInput {
  ticketId: number;
  sourceStage: RecoverySourceStage;
  sourceProcessId: RecoverySourceProcessId;
  sourceStageRunId: number | null;
  sourceProcessRunId: number | null;
  triggerKind: RecoveryTriggerKind;
  triggerDetail: string;
  maxRounds: number;
  startedAt: string;
}

/**
 * Open a recovery round for a gate failure, atomically with the verdict that
 * caused it (called from `commitGateOutcome`'s transition premutate).
 *
 * The round number is per (ticket, source_stage), so a ticket's uat failures
 * and its review failures each order themselves. If this failure is the
 * REVALIDATION of an active round — the round sits at 'revalidating' and this
 * run is (or becomes) its revalidation run — the old round is marked `failed`
 * FIRST and the new round describes the new cause; a round is never replaced
 * silently, because the fact that the previous fix did not land is exactly
 * what the series exists to record.
 */
export function openRecoveryRound(store: Store, input: OpenRecoveryRoundInput): RecoveryRound {
  let created: RecoveryRound | undefined;
  const apply = store.db.transaction(() => {
    const revalidating = activeRoundAnyStage(store, input.ticketId);
    if (revalidating !== null) {
      const revalidatesThisRound =
        (input.sourceStage === 'uat' &&
          (revalidating.uatRevalidationStageRunId === null ||
            revalidating.uatRevalidationStageRunId === input.sourceStageRunId)) ||
        (input.sourceStage === 'review' &&
          // A ship-sourced round revalidates through review as its terminal
          // stage too, so a review failure fails it exactly as it fails a
          // review-origin round (`completeRevalidation` mirrors this on pass).
          (revalidating.sourceStage === 'review' || revalidating.sourceStage === 'ship') &&
          (revalidating.reviewRevalidationStageRunId === null ||
            revalidating.reviewRevalidationStageRunId === input.sourceStageRunId));
      if (revalidatesThisRound) {
        // Backfill the run link when the open-time attach missed it (a run that
        // was stopped before the failing one), then fail the round: its fix did
        // not take. The NEW round below describes the new cause.
        if (input.sourceStage === 'uat') {
          store.db
            .prepare('UPDATE recovery_rounds SET uat_revalidation_stage_run_id = ? WHERE id = ?')
            .run(input.sourceStageRunId, revalidating.id);
        } else {
          store.db
            .prepare('UPDATE recovery_rounds SET review_revalidation_stage_run_id = ? WHERE id = ?')
            .run(input.sourceStageRunId, revalidating.id);
        }
        store.db
          .prepare(
            `UPDATE recovery_rounds SET status = 'failed', ended_at = ?
              WHERE id = ? AND status = 'revalidating'`,
          )
          .run(input.startedAt, revalidating.id);
      }
    }

    const episode = currentEpisode(store, input.ticketId, input.sourceStage);
    const prev = store.db
      .prepare(
        `SELECT MAX(round) AS max_round FROM recovery_rounds
          WHERE ticket_id = ? AND source_stage = ? AND episode = ?`,
      )
      .get(input.ticketId, input.sourceStage, episode) as { max_round: number | null } | undefined;
    const roundNumber = (prev?.max_round ?? 0) + 1;

    const info = store.db
      .prepare(
        `INSERT INTO recovery_rounds
           (ticket_id, source_stage, source_process_id, source_stage_run_id,
            source_process_run_id, trigger_kind, trigger_detail, episode, round, max_rounds,
            fix_process_run_id, uat_revalidation_stage_run_id,
            review_revalidation_stage_run_id, status, started_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 'pending', ?, NULL)`,
      )
      .run(
        input.ticketId,
        input.sourceStage,
        input.sourceProcessId,
        input.sourceStageRunId,
        input.sourceProcessRunId,
        input.triggerKind,
        input.triggerDetail,
        episode,
        roundNumber,
        input.maxRounds,
        input.startedAt,
      );
    created = roundById(store, Number(info.lastInsertRowid));
  });
  apply();
  if (created === undefined) throw new Error('recovery round insert did not land');
  return created;
}

/**
 * Complete an active round's revalidation from a PASSED verdict.
 *
 * The run must be the round's attached revalidation run (attached by
 * `attachRevalidationStageRun` when it opened). A UAT-origin round is passed by
 * its UAT revalidation; a Review-origin round stays revalidating through UAT
 * and is passed only by its own Review revalidation — the graph is never
 * bypassed, so the round can never complete on the wrong stage's verdict.
 * Called from `commitGateOutcome`'s premutate, inside the verdict transaction.
 */
export function completeRevalidation(
  store: Store,
  input: { ticketId: number; stageKey: RecoverySourceStage; stageRunId: number; endedAt: string },
): void {
  const revalidating = activeRoundAnyStage(store, input.ticketId);
  if (revalidating === null) return;
  if (input.stageKey === 'uat' && revalidating.uatRevalidationStageRunId === input.stageRunId) {
    if (revalidating.sourceStage === 'uat') {
      store.db
        .prepare(
          `UPDATE recovery_rounds SET status = 'passed', ended_at = ?
            WHERE id = ? AND status = 'revalidating'`,
        )
        .run(input.endedAt, revalidating.id);
    }
    // A Review- or Ship-origin round is NOT passed by UAT: it awaits its own
    // Review run. (A ship-sourced round revalidates uat THEN review, exactly
    // like a review round, so review is its terminal revalidation.)
  } else if (
    input.stageKey === 'review' &&
    (revalidating.sourceStage === 'review' || revalidating.sourceStage === 'ship') &&
    revalidating.reviewRevalidationStageRunId === input.stageRunId
  ) {
    store.db
      .prepare(
        `UPDATE recovery_rounds SET status = 'passed', ended_at = ?
          WHERE id = ? AND status = 'revalidating'`,
      )
      .run(input.endedAt, revalidating.id);
  }
}

/**
 * Attach a newly-opened gate run to the ticket's active revalidating round,
 * when this stage is the round's next revalidation. Called by `openGateRun`
 * the moment the run opens, so the round names its revalidation evidence even
 * before any verdict exists. The slot is overwritten unconditionally: while a
 * round is revalidating, the LATEST run of that stage is the revalidation.
 */
export function attachRevalidationStageRun(
  store: Store,
  ticketId: number,
  stageKey: RecoverySourceStage,
  runId: number,
): void {
  const revalidating = activeRoundAnyStage(store, ticketId);
  if (revalidating === null) return;
  if (stageKey === 'uat') {
    store.db
      .prepare('UPDATE recovery_rounds SET uat_revalidation_stage_run_id = ? WHERE id = ?')
      .run(runId, revalidating.id);
  } else if (revalidating.sourceStage === 'review' || revalidating.sourceStage === 'ship') {
    // A uat-origin round is passed by its uat run, so review is never its
    // revalidation; a review- or ship-origin round revalidates through review
    // and this is its terminal slot.
    store.db
      .prepare('UPDATE recovery_rounds SET review_revalidation_stage_run_id = ? WHERE id = ?')
      .run(runId, revalidating.id);
  }
}

export interface BeginLiveFixExecutionInput {
  ticketId: number;
  roundId: number;
  provider?: string | null;
  model?: string | null;
  agentName?: string | null;
  startedAt: string;
}

/**
 * Open the Fix process run for a LIVE session (the nudge path) and attach it
 * to the round, immediately before the Fix brief is delivered — the execution
 * is durably owned from its first token. Transactional: the run and the
 * attachment land together. Only a `pending` round of THIS ticket accepts an
 * execution; a round already fixing (or revalidating/passed), or one owned by
 * another ticket, is not attached — the transaction rolls the run back.
 */
export function beginLiveFixExecution(
  store: Store,
  input: BeginLiveFixExecutionInput,
): ProcessRun {
  let run!: ProcessRun;
  const apply = store.db.transaction(() => {
    run = openProcessRun(store, {
      ticketId: input.ticketId,
      stageKey: 'fix',
      processId: 'fix',
      attempt: stageAttempt(store, input.ticketId, 'fix'),
      provider: input.provider ?? null,
      model: input.model ?? null,
      agentName: input.agentName ?? null,
      startedAt: input.startedAt,
    });
    const info = store.db
      .prepare(
        `UPDATE recovery_rounds SET fix_process_run_id = ?, status = 'fixing'
          WHERE id = ? AND ticket_id = ? AND status = 'pending'`,
      )
      .run(run.id, input.roundId, input.ticketId);
    if (info.changes === 0) {
      const round = roundById(store, input.roundId);
      throw new Error(
        round !== undefined && round.ticketId !== input.ticketId
          ? `cannot begin fix execution: recovery round ${input.roundId} is owned by ticket ${round.ticketId}, not ${input.ticketId}`
          : `cannot begin fix execution: recovery round ${input.roundId} is not pending`,
      );
    }
    // A real execution is now attached — a row some earlier park re-stamped as
    // failed reads live again (see `markFixStageLive`).
    markFixStageLive(store, input.ticketId);
  });
  apply();
  return run;
}

export interface RecordFixLaunchIntentInput {
  ticketId: number;
  launchId: string;
  provider: string;
  model?: string | null;
  /**
   * v33: the CONFIGURED Fix process agent name (uat-fix/review-fix), resolved
   * once at resume time. The intent row persists it so the SessionStart can
   * open the Fix process run with the identity that was resolved — a later
   * manifest edit never rewrites the snapshot.
   */
  agentName?: string | null;
  reason: 'initial' | 'resume' | 'switch';
  sessionOrigin: 'new' | 'resume' | 'unknown';
  recoveryRoundId: number;
  at: string;
}

/**
 * Persist a CLOSED-session Fix launch intent (v30): the recovery round id,
 * the assignment snapshot, the launch id and the session origin ride the row,
 * so the eventual SessionStart can open the Fix process run and attach it to
 * the round even after a reload. The round must be `pending` — a fix execution
 * may only attach to a round that is waiting for one.
 */
export function recordFixLaunchIntent(
  store: Store,
  input: RecordFixLaunchIntentInput,
): SessionLaunchIntent {
  const round = roundById(store, input.recoveryRoundId);
  if (round === undefined) {
    throw new Error(`fix launch intent references unknown recovery round ${input.recoveryRoundId}`);
  }
  if (round.ticketId !== input.ticketId) {
    throw new Error(
      `fix launch intent references recovery round ${input.recoveryRoundId} owned by ticket ${round.ticketId}, not ${input.ticketId}`,
    );
  }
  if (round.status !== 'pending') {
    throw new Error(
      `recovery round ${input.recoveryRoundId} is not pending (${round.status}) — no fix launch may attach to it`,
    );
  }
  return recordSessionLaunchIntent(store, {
    ticketId: input.ticketId,
    launchId: input.launchId,
    purpose: 'fix',
    provider: input.provider,
    model: input.model ?? null,
    agentName: input.agentName ?? null,
    reason: input.reason,
    sessionOrigin: input.sessionOrigin,
    recoveryRoundId: input.recoveryRoundId,
    at: input.at,
  });
}

export type ConfirmFixLaunchResult =
  | 'confirmed'
  | 'unknown'
  | 'not-pending'
  | 'ticket-mismatch'
  | 'provider-mismatch'
  | 'round-mismatch';

/**
 * Confirm a FIX launch intent from its accepted SessionStart. The process run
 * is opened and attached to BOTH the intent and the recovery round in the
 * same transaction as the confirmation — a fix session is owned by its round
 * from the first token. `onLaunchFailed`, supersession, or a stale/mismatched
 * start resolve the intent WITHOUT creating a process run.
 *
 * The round is re-validated INSIDE the transaction: the intent's ticket id,
 * provider and pending status were checked at the record boundary, but a
 * malformed HISTORICAL row (written by an older build, or forged) can carry
 * this ticket's id and ANOTHER ticket's round. The confirmation requires
 * `(round.id, round.ticketId, round.status = 'pending')` to all match the
 * intent before anything is opened, and the round attachment itself is
 * constrained to that same triple — if the constrained UPDATE changes zero
 * rows, the opened process run and the intent confirmation are rolled back
 * with the transaction, never committed half-attached.
 */
export function confirmFixLaunch(
  store: Store,
  launchId: string,
  input: ConfirmSessionLaunchIntentInput,
): ConfirmFixLaunchResult {
  const intent = getSessionLaunchIntent(store, launchId);
  if (intent === undefined) return 'unknown';
  if (intent.purpose !== 'fix' || intent.status !== 'pending') return 'not-pending';
  if (intent.ticketId !== input.ticketId) return 'ticket-mismatch';
  if (intent.provider !== input.provider) return 'provider-mismatch';

  let result: ConfirmFixLaunchResult = 'confirmed';
  const apply = store.db.transaction(() => {
    if (intent.recoveryRoundId !== null) {
      const round = roundById(store, intent.recoveryRoundId);
      if (
        round === undefined ||
        round.ticketId !== intent.ticketId ||
        round.status !== 'pending'
      ) {
        // The intent names a round this ticket does not own (or one that is no
        // longer pending): the confirmation is rejected atomically — nothing is
        // opened and the intent stays pending.
        result = 'round-mismatch';
        return;
      }
      const run = openProcessRun(store, {
        ticketId: intent.ticketId,
        stageKey: 'fix',
        processId: 'fix',
        attempt: stageAttempt(store, intent.ticketId, 'fix'),
        provider: intent.provider,
        model: intent.model,
        // v33: the configured Fix agent name resolved at resume time and
        // persisted on the intent — the process run snapshots it, so a later
        // manifest edit never rewrites the identity that actually ran.
        agentName: intent.agentName,
        startedAt: input.at,
      });
      store.db
        .prepare('UPDATE session_launch_intents SET process_run_id = ? WHERE id = ?')
        .run(run.id, intent.id);
      const info = store.db
        .prepare(
          `UPDATE recovery_rounds SET fix_process_run_id = ?, status = 'fixing'
            WHERE id = ? AND ticket_id = ? AND status = 'pending'`,
        )
        .run(run.id, round.id, round.ticketId);
      if (info.changes === 0) {
        // The round moved between the read and the constrained update: the
        // opened process run and the intent confirmation roll back with this
        // throw — a confirmation is never committed half-attached.
        throw new Error(
          `cannot confirm fix launch: recovery round ${round.id} is no longer pending for ticket ${round.ticketId}`,
        );
      }
      // The launch confirmed into a live execution — same re-stamp as
      // `beginLiveFixExecution` (see `markFixStageLive`).
      markFixStageLive(store, round.ticketId);
    }
    confirmLaunchIntentRow(store, intent.id, input.providerSessionId, input.at);
  });
  apply();
  return result;
}

/**
 * Complete the Fix execution from the `stage fix pass` marker — the ONLY
 * completion authority. Runs as the marker transition's premutate, inside the
 * same transaction as the fix→uat advance: the linked Fix process run passes
 * and the round moves to `revalidating` together with the verdict, or not at
 * all. No-op (returns false) when the ticket has no active round — a pre-v30
 * ticket at fix transitions untracked.
 */
export function completeFixExecution(store: Store, ticketId: number, endedAt: string): boolean {
  const round = activeFixRound(store, ticketId);
  if (round === null) return false;
  if (round.fixProcessRunId !== null) {
    finishProcessRun(store, round.fixProcessRunId, 'passed', endedAt);
  }
  const info = store.db
    .prepare(
      `UPDATE recovery_rounds SET status = 'revalidating'
        WHERE id = ? AND status IN ('pending','fixing')`,
    )
    .run(round.id);
  return info.changes > 0;
}

/**
 * Interrupt a Fix execution — a session that died without the marker (the
 * crash path), or a delivery that failed before the brief reached the agent.
 * The linked process run and the round both mark `interrupted`; no additional
 * round is consumed. Only a `fixing` round is interruptible: a round with no
 * execution yet is waiting, not crashed.
 */
export function interruptFixExecution(store: Store, roundId: number, at: string): boolean {
  const round = roundById(store, roundId);
  if (round === undefined || round.status !== 'fixing') return false;
  const apply = store.db.transaction(() => {
    if (round.fixProcessRunId !== null) {
      finishProcessRun(store, round.fixProcessRunId, 'interrupted', at);
    }
    // v45: a crash consumes no round, but it DOES advance `interrupt_count` —
    // the one thing that bounds the driver's reopen of this round, so a fix
    // that keeps dying without the marker cannot relaunch forever.
    store.db
      .prepare(
        `UPDATE recovery_rounds SET status = 'interrupted', ended_at = ?,
           interrupt_count = interrupt_count + 1
          WHERE id = ? AND status = 'fixing'`,
      )
      .run(at, roundId);
    // The fix died without the marker: the ticket rests at fix for a human,
    // and the stage row must stop claiming the agent is still fixing.
    parkFixStage(store, round.ticketId, FIX_PARKED_INTERRUPTED, at);
  });
  apply();
  return true;
}

/**
 * Interrupt the ticket's active Fix execution, if one is in flight — the hook
 * boundary's view of the same crash (`SessionEnd` without the marker). A
 * round with no running execution is left strictly alone.
 */
export function interruptActiveFixExecution(store: Store, ticketId: number, at: string): boolean {
  const row = store.db
    .prepare(
      `SELECT id FROM recovery_rounds
        WHERE ticket_id = ? AND status = 'fixing'
        ORDER BY id DESC LIMIT 1`,
    )
    .get(ticketId) as { id: number } | undefined;
  if (row === undefined) return false;
  return interruptFixExecution(store, row.id, at);
}

/**
 * Mark a pending round EXHAUSTED — the driver's terminal transition when the
 * committed budget is spent: the ticket rests at fix, handed to a human, and
 * `activeRecoverySeries` reads the exhausted round as history so no later
 * drive can reconsider it. Constrained to (id, ticket_id, status='pending'):
 * a round already terminal, fixing, or revalidating is never overwritten, and
 * another ticket's round is left strictly alone. Returns whether the round
 * actually transitioned — an already-terminal round is an idempotent no-op.
 */
export function exhaustRecoveryRound(
  store: Store,
  ticketId: number,
  roundId: number,
  endedAt: string,
): boolean {
  const changes =
    store.db
      .prepare(
        `UPDATE recovery_rounds SET status = 'exhausted', ended_at = ?
          WHERE id = ? AND ticket_id = ? AND status = 'pending'`,
      )
      .run(endedAt, roundId, ticketId).changes === 1;
  if (changes) {
    // The budget is spent and the ticket rests at fix for a human — the stage
    // row must read parked, not running (see `parkFixStage`).
    parkFixStage(store, ticketId, FIX_PARKED_EXHAUSTED, endedAt);
  }
  return changes;
}

/**
 * The inverse of `interruptFixExecution`: move an interrupted round back to
 * `pending` so the driver can resume it. An interrupt consumes NO additional
 * round, so a crash within budget is resumable — never terminal history.
 * Constrained to (id, ticket_id, status='interrupted') exactly like
 * `exhaustRecoveryRound` constrains to 'pending': a pending/fixing round is
 * never overwritten, and another ticket's round is left strictly alone. The
 * fix stage row is NOT re-stamped here — `beginLiveFixExecution` /
 * `confirmFixLaunch` call `markFixStageLive` when a real execution attaches.
 * `interrupt_count` is left UNCHANGED — it is the crash tally that bounds
 * future reopens, never reset by one. Returns whether the round actually
 * reopened.
 */
export function reopenInterruptedRound(
  store: Store,
  ticketId: number,
  roundId: number,
): boolean {
  return (
    store.db
      .prepare(
        `UPDATE recovery_rounds SET status = 'pending', ended_at = NULL
          WHERE id = ? AND ticket_id = ? AND status = 'interrupted'`,
      )
      .run(roundId, ticketId).changes === 1
  );
}
