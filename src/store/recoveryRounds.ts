import type { Store } from './db.js';
import { openProcessRun, finishProcessRun, type ProcessRun } from './processRuns.js';
import {
  recordSessionLaunchIntent,
  confirmLaunchIntentRow,
  getSessionLaunchIntent,
  type ConfirmSessionLaunchIntentInput,
  type SessionLaunchIntent,
} from './sessionLaunchIntents.js';
import { setStage, stageAttempt } from './stages.js';

/**
 * `recovery_rounds` (v30) — one row per CAUSAL recovery round: a gate failure
 * that entered the fix loop, snapshotted atomically with the verdict that
 * caused it (the round opens inside `commitGateOutcome`'s transition
 * premutate, so the failing verdict, its evidence and the round commit
 * together or not at all).
 *
 * The round is the durable owner of the recovery, and the driver reads the
 * committed `max_rounds` back from it — never from the live manifest, which
 * may have changed since the failure — and the round id back into the Fix
 * execution (`beginLiveFixExecution` / `confirmFixLaunch`), so every piece of
 * the recovery is linked by row, not reconstructed from mutable state.
 *
 * Status lifecycle:
 *   pending      — opened by the failing verdict, no Fix execution yet
 *   fixing       — a Fix process run is attached (live nudge or confirmed start)
 *   revalidating — the `stage fix pass` marker passed the Fix execution
 *   passed       — the revalidation outcome proved the fix (see below)
 *   failed       — the revalidation outcome disproved it, and the atomically
 *                  opened round of the NEW failure describes the new cause
 *   interrupted  — the Fix session died without the marker; never a pass, and
 *                  no additional round is consumed
 *
 * Revalidation: the next UAT run attaches to `uat_revalidation_stage_run_id`
 * (and, for a Review-origin round, the later Review run to
 * `review_revalidation_stage_run_id`). A UAT-origin round is completed or
 * failed by that UAT outcome; a Review-origin round needs BOTH — UAT must
 * pass (leaving the round revalidating) before Review's run is attached, and
 * only that Review outcome completes or fails the original round. An
 * intermediate UAT failure fails the Review-origin round and lets the
 * atomically created UAT round describe the new cause. The graph is never
 * bypassed: fix always re-enters uat.
 *
 * `store.db.prepare(...)` with positional `?` only, per the driver-agnostic
 * rule (the marker CLI's flat `node:sqlite` shim must be able to run the
 * completion paths without nesting transactions).
 */

export type RecoverySourceStage = 'uat' | 'review';
export type RecoverySourceProcessId = 'gates' | 'tester' | 'review';
export type RecoveryTriggerKind =
  | 'gate-failure'
  | 'tester-verifier-failure'
  | 'blocking-review-findings';
export type RecoveryStatus =
  | 'pending'
  | 'fixing'
  | 'revalidating'
  | 'passed'
  | 'failed'
  | 'exhausted'
  | 'interrupted';

/** Terminal statuses — a round in one of these will never change again. */

export interface RecoveryRound {
  id: number;
  ticketId: number;
  sourceStage: RecoverySourceStage;
  sourceProcessId: RecoverySourceProcessId;
  sourceStageRunId: number | null;
  sourceProcessRunId: number | null;
  triggerKind: RecoveryTriggerKind;
  triggerDetail: string;
  round: number;
  maxRounds: number;
  fixProcessRunId: number | null;
  uatRevalidationStageRunId: number | null;
  reviewRevalidationStageRunId: number | null;
  status: RecoveryStatus;
  startedAt: string;
  endedAt: string | null;
}

interface RecoveryRoundRow {
  id: number;
  ticket_id: number;
  source_stage: string;
  source_process_id: string;
  source_stage_run_id: number | null;
  source_process_run_id: number | null;
  trigger_kind: string;
  trigger_detail: string;
  round: number;
  max_rounds: number;
  fix_process_run_id: number | null;
  uat_revalidation_stage_run_id: number | null;
  review_revalidation_stage_run_id: number | null;
  status: string;
  started_at: string;
  ended_at: string | null;
}

const SOURCE_PROCESS_IDS: readonly string[] = ['gates', 'tester', 'review'];
const TRIGGER_KINDS: readonly string[] = [
  'gate-failure',
  'tester-verifier-failure',
  'blocking-review-findings',
];
const STATUSES: readonly string[] = [
  'pending',
  'fixing',
  'revalidating',
  'passed',
  'failed',
  'exhausted',
  'interrupted',
];

/**
 * The karst-authored verdicts a PARKED fix stage row carries — the closed set
 * of "the fix is no longer in flight" reasons. Written by the interrupt/exhaust
 * paths and the driver's leave branches, read by the stepper's fault card and
 * the Now line; never free-form prose, because these are the words the
 * dashboard repeats back to the user.
 */
export const FIX_PARKED_INTERRUPTED = 'fix session ended without the done marker';
export const FIX_PARKED_EXHAUSTED = 'fix attempts exhausted';
export const FIX_PARKED_NO_RESUMABLE_ROUND = 'fix parked — no resumable recovery round';
export const FIX_PARKED_NO_FAILED_GATE = 'fix parked — no failed gate to resume';
export const FIX_PARKED_PROCESS_UNAVAILABLE = 'fix process not available — parked for a human';
export const FIX_PARKED_NO_EXECUTION = 'fix parked — no fix execution in flight';

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

function rowToRound(r: RecoveryRoundRow): RecoveryRound {
  return {
    id: r.id,
    ticketId: r.ticket_id,
    sourceStage: r.source_stage as RecoverySourceStage,
    // Closed vocabularies at a read boundary over an append-only table: an
    // unrecognized value degrades to the conservative answer rather than being
    // carried through as a value no consumer handles.
    sourceProcessId: (SOURCE_PROCESS_IDS.includes(r.source_process_id)
      ? r.source_process_id
      : 'gates') as RecoverySourceProcessId,
    triggerKind: (TRIGGER_KINDS.includes(r.trigger_kind)
      ? r.trigger_kind
      : 'gate-failure') as RecoveryTriggerKind,
    triggerDetail: r.trigger_detail,
    sourceStageRunId: r.source_stage_run_id,
    sourceProcessRunId: r.source_process_run_id,
    round: r.round,
    maxRounds: r.max_rounds,
    fixProcessRunId: r.fix_process_run_id,
    uatRevalidationStageRunId: r.uat_revalidation_stage_run_id,
    reviewRevalidationStageRunId: r.review_revalidation_stage_run_id,
    status: (STATUSES.includes(r.status) ? r.status : 'interrupted') as RecoveryStatus,
    startedAt: r.started_at,
    endedAt: r.ended_at,
  };
}

const ROUND_SELECT =
  `SELECT id, ticket_id, source_stage, source_process_id, source_stage_run_id,
          source_process_run_id, trigger_kind, trigger_detail, round, max_rounds,
          fix_process_run_id, uat_revalidation_stage_run_id,
          review_revalidation_stage_run_id, status, started_at, ended_at
     FROM recovery_rounds`;

function roundById(store: Store, id: number): RecoveryRound | undefined {
  const row = store.db.prepare(`${ROUND_SELECT} WHERE id = ?`).get(id) as
    | RecoveryRoundRow
    | undefined;
  return row === undefined ? undefined : rowToRound(row);
}

/**
 * The ticket's latest round for ONE source stage that is still ACTIVE —
 * a terminal round (passed/failed/exhausted/interrupted) is history, not a
 * series the driver can resume or the store can attach revalidation to.
 */
export function activeRecoverySeries(
  store: Store,
  ticketId: number,
  sourceStage: RecoverySourceStage,
): RecoveryRound | null {
  const row = store.db
    .prepare(
      `${ROUND_SELECT} WHERE ticket_id = ? AND source_stage = ?
          AND status NOT IN ('passed','failed','exhausted','interrupted')
        ORDER BY id DESC LIMIT 1`,
    )
    .get(ticketId, sourceStage) as RecoveryRoundRow | undefined;
  return row === undefined ? null : rowToRound(row);
}

/**
 * The ticket's latest ACTIVE round of ANY source stage — at most one exists at
 * a time: a round leaves 'pending'/'fixing' only through the marker (one fix at
 * a time) and only one round can be awaiting revalidation.
 */
function activeRoundAnyStage(store: Store, ticketId: number): RecoveryRound | null {
  const row = store.db
    .prepare(
      `${ROUND_SELECT} WHERE ticket_id = ? AND status = 'revalidating'
        ORDER BY id DESC LIMIT 1`,
    )
    .get(ticketId) as RecoveryRoundRow | undefined;
  return row === undefined ? null : rowToRound(row);
}

/** The round a Fix marker completes — the latest pending/fixing round. */
function activeFixRound(store: Store, ticketId: number): RecoveryRound | null {
  const row = store.db
    .prepare(
      `${ROUND_SELECT} WHERE ticket_id = ? AND status IN ('pending','fixing')
        ORDER BY id DESC LIMIT 1`,
    )
    .get(ticketId) as RecoveryRoundRow | undefined;
  return row === undefined ? null : rowToRound(row);
}

/**
 * Whether a fix EXECUTION is attached to the ticket right now — a `fixing`
 * round. This is the one store fact that means "the agent is actually being
 * fixed": a pending round is a fix that never started, a terminal round a fix
 * that ended, and neither may claim the fix stage is live. The pending-launch
 * window (intent recorded, SessionStart not yet arrived) is not a live
 * execution either — the moment the start is accepted, `confirmFixLaunch`
 * moves the round to `fixing`, so the row reads live again within the same
 * transaction.
 */
export function hasFixingRound(store: Store, ticketId: number): boolean {
  return (
    store.db
      .prepare(
        "SELECT 1 FROM recovery_rounds WHERE ticket_id = ? AND status = 'fixing' LIMIT 1",
      )
      .get(ticketId) !== undefined
  );
}

/**
 * The driver's view of a recovery: the committed round id and `max_rounds` of
 * the ticket's active series for one gate, so the resume decision reads the
 * budget AS IT WAS when the failure was committed — a manifest knob changed
 * after the failure must not retroactively widen (or narrow) a round already
 * in flight.
 */
export interface RecoveryDecision {
  roundId: number;
  round: number;
  sourceStage: RecoverySourceStage;
  maxRounds: number;
  status: RecoveryStatus;
}

export function recoveryDecision(
  store: Store,
  ticketId: number,
  sourceStage: RecoverySourceStage,
): RecoveryDecision | null {
  const round = activeRecoverySeries(store, ticketId, sourceStage);
  if (round === null) return null;
  return {
    roundId: round.id,
    round: round.round,
    sourceStage: round.sourceStage,
    maxRounds: round.maxRounds,
    status: round.status,
  };
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
          revalidating.sourceStage === 'review' &&
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

    const prev = store.db
      .prepare(
        `SELECT MAX(round) AS max_round FROM recovery_rounds
          WHERE ticket_id = ? AND source_stage = ?`,
      )
      .get(input.ticketId, input.sourceStage) as { max_round: number | null } | undefined;
    const roundNumber = (prev?.max_round ?? 0) + 1;

    const info = store.db
      .prepare(
        `INSERT INTO recovery_rounds
           (ticket_id, source_stage, source_process_id, source_stage_run_id,
            source_process_run_id, trigger_kind, trigger_detail, round, max_rounds,
            fix_process_run_id, uat_revalidation_stage_run_id,
            review_revalidation_stage_run_id, status, started_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 'pending', ?, NULL)`,
      )
      .run(
        input.ticketId,
        input.sourceStage,
        input.sourceProcessId,
        input.sourceStageRunId,
        input.sourceProcessRunId,
        input.triggerKind,
        input.triggerDetail,
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
    // A Review-origin round is NOT passed by UAT: it awaits its own Review run.
  } else if (
    input.stageKey === 'review' &&
    revalidating.sourceStage === 'review' &&
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
  } else if (revalidating.sourceStage === 'review') {
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
    store.db
      .prepare(
        `UPDATE recovery_rounds SET status = 'interrupted', ended_at = ?
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
 * One stranded fix this sweep settled, reported so the loss is never silent.
 * `kind` tells the two halves apart: `execution` is an interrupted fix
 * execution (round-based), `stage` is a fix stage row that read `running` with
 * no execution at all — parked, never interrupted, because there was no
 * execution to interrupt.
 */
export type StrandedFixKind = 'execution' | 'stage';

export interface StrandedFixRound {
  kind: StrandedFixKind;
  /** The interrupted round, for an execution; null for a stage park. */
  roundId: number | null;
  ticketId: number;
  /** The round's source stage, for an execution; null for a stage park. */
  sourceStage: RecoverySourceStage | null;
  /** The round's number, for an execution; null for a stage park. */
  round: number | null;
  fixProcessRunId: number | null;
}

/**
 * Settle every stranded fix state at activation, in two passes.
 *
 * PASS 1 — interrupt every `fixing` round whose Fix execution can no longer be
 * running. `fixing` is the one recovery status nothing can leave on its own:
 * the marker is the only completion authority, and a session that dies without
 * firing it fires no signal either. The driver reads such a round as "a fix
 * execution is already in flight" and leaves the ticket alone — forever, which
 * is exactly how a ticket sat at fix for ten hours with an idle agent and no
 * session (869ee...): the SessionEnd hook that would have called
 * `interruptActiveFixExecution` never reached the endpoint, and the process-run
 * sweep marked the run stale without propagating that to the round.
 *
 * Stranded means one of two things, both proven from stored state rather than
 * guessed: the round carries NO Fix process run (nothing was ever opened, or
 * its launch never confirmed), or the run it carries is no longer `running`
 * (another window's open superseded it, or the activation sweep found its
 * process gone). A run still `running` is left STRICTLY alone — a live fix in
 * this or any other window must never be accused of having died, which is why
 * this sweep runs AFTER `reconcileProcessRuns` rather than judging liveness
 * itself.
 *
 * PASS 2 — park every fix stage row that reads `running` with NO `fixing`
 * round at all: a ticket at fix whose execution never started (no round, a
 * pending round nothing ever attached to, or only terminal rounds) is waiting
 * for a human, not being fixed, and the row must not claim otherwise. This is
 * the sweep that heals tickets parked by OLDER builds — the round-level pass
 * and the terminal-close sweep only settle executions that were ever started.
 *
 * Global like the run sweeps and for the same reason: the registry is shared by
 * every IDE window, and a stranded fix is wrong in whichever project owns it.
 */
export function reconcileStrandedFixRounds(store: Store, at: string): StrandedFixRound[] {
  const rows = store.db
    .prepare(
      `${ROUND_SELECT} WHERE status = 'fixing'
          AND (fix_process_run_id IS NULL
               OR fix_process_run_id IN
                    (SELECT id FROM process_runs WHERE status <> 'running'))
        ORDER BY id`,
    )
    .all()
    .map((r) => rowToRound(r as RecoveryRoundRow));

  const stranded: StrandedFixRound[] = [];
  for (const round of rows) {
    if (!interruptFixExecution(store, round.id, at)) continue;
    stranded.push({
      kind: 'execution',
      roundId: round.id,
      ticketId: round.ticketId,
      sourceStage: round.sourceStage,
      round: round.round,
      fixProcessRunId: round.fixProcessRunId,
    });
  }

  const parked = store.db
    .prepare(
      `SELECT id FROM tickets
        WHERE stage_current = 'fix'
          AND EXISTS (
            SELECT 1 FROM stages
             WHERE ticket_id = tickets.id AND stage_key = 'fix' AND status = 'running')
          AND NOT EXISTS (
            SELECT 1 FROM recovery_rounds
             WHERE ticket_id = tickets.id AND status = 'fixing')
        ORDER BY id`,
    )
    .all() as { id: number }[];
  for (const row of parked) {
    if (!parkFixStage(store, row.id, FIX_PARKED_NO_EXECUTION, at)) continue;
    stranded.push({
      kind: 'stage',
      roundId: null,
      ticketId: row.id,
      sourceStage: null,
      round: null,
      fixProcessRunId: null,
    });
  }

  return stranded;
}

/** One line naming a stranded fix this sweep settled, for the output channel. */
export function describeStrandedFixRound(s: StrandedFixRound): string {
  if (s.kind === 'stage') {
    return (
      `karst: ticket ${s.ticketId}: fix stage read running with no fix execution ` +
      `in flight — parked for a human`
    );
  }
  return (
    `karst: ticket ${s.ticketId}: ${s.sourceStage} recovery round ${s.round} was fixing ` +
    `with no live fix execution${s.fixProcessRunId === null ? ' (none was ever opened)' : ''} — ` +
    `marked interrupted; the ticket rests at fix for a human`
  );
}

/** Every round recorded for a ticket, oldest first (insertion order is round order). */
export function listRecoveryRounds(store: Store, ticketId: number): RecoveryRound[] {
  return store.db
    .prepare(`${ROUND_SELECT} WHERE ticket_id = ? ORDER BY id`)
    .all(ticketId)
    .map((r) => rowToRound(r as RecoveryRoundRow));
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
