import type { Store } from './db.js';

export type RecoverySourceStage = 'uat' | 'review' | 'ship';
export type RecoverySourceProcessId = 'gates' | 'tester' | 'review' | 'pr-review';
export type RecoveryTriggerKind =
  | 'gate-failure'
  | 'tester-verifier-failure'
  /**
   * A UAT Tester observation at or above `uat.testerObservations.blockingSeverity`
   * (default `'none'` — never produced unless a project opts in). The UAT twin of
   * `blocking-review-findings`.
   */
  | 'blocking-tester-observations'
  | 'blocking-review-findings'
  /**
   * A human team left unresolved review feedback on a pull request this ticket
   * opened. The ship twin of `blocking-review-findings`: the findings come from
   * people upstream rather than from karst's own review lane.
   */
  | 'upstream-changes-requested';
export type RecoveryStatus =
  | 'pending'
  | 'fixing'
  | 'revalidating'
  | 'passed'
  | 'failed'
  | 'exhausted'
  | 'interrupted'
  | 'refused'
  | 'reset';

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
  episode: number;
  round: number;
  maxRounds: number;
  fixProcessRunId: number | null;
  uatRevalidationStageRunId: number | null;
  reviewRevalidationStageRunId: number | null;
  status: RecoveryStatus;
  startedAt: string;
  endedAt: string | null;
  /** How many times this round's fix execution has been interrupted (a crash
   *  consumes no round, so this is the only thing that advances on a crash —
   *  the driver's reopen bound). */
  interruptCount: number;
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
  episode: number;
  round: number;
  max_rounds: number;
  fix_process_run_id: number | null;
  uat_revalidation_stage_run_id: number | null;
  review_revalidation_stage_run_id: number | null;
  status: string;
  started_at: string;
  ended_at: string | null;
  interrupt_count: number;
}

const SOURCE_PROCESS_IDS: readonly string[] = ['gates', 'tester', 'review', 'pr-review'];
const TRIGGER_KINDS: readonly string[] = [
  'gate-failure',
  'tester-verifier-failure',
  'blocking-tester-observations',
  'blocking-review-findings',
  'upstream-changes-requested',
];
const STATUSES: readonly string[] = [
  'pending',
  'fixing',
  'revalidating',
  'passed',
  'failed',
  'exhausted',
  'interrupted',
  'refused',
  'reset',
];

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
    episode: r.episode,
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
    interruptCount: r.interrupt_count,
  };
}

const ROUND_SELECT =
  `SELECT id, ticket_id, source_stage, source_process_id, source_stage_run_id,
          source_process_run_id, trigger_kind, trigger_detail, episode, round, max_rounds,
          fix_process_run_id, uat_revalidation_stage_run_id,
          review_revalidation_stage_run_id, status, started_at, ended_at, interrupt_count
     FROM recovery_rounds`;

export function roundById(store: Store, id: number): RecoveryRound | undefined {
  const row = store.db.prepare(`${ROUND_SELECT} WHERE id = ?`).get(id) as
    | RecoveryRoundRow
    | undefined;
  return row === undefined ? undefined : rowToRound(row);
}

/**
 * The current episode for (ticket, source_stage): a `passed` or `reset` round
 * ends an episode, so the next failure opens in `ended_episodes + 1`. A
 * `failed`/`exhausted`/`interrupted`/`refused` round does NOT end the episode,
 * so the next round stays in the same one — `exhausted` is NOT a pass, so
 * raising the manifest budget re-opens the same episode at the next round
 * rather than dead-ending forever (Issue #1, the root cause).
 *
 * Episodes are strictly sequential: episode N+1 cannot open until episode N
 * has a `passed`/`reset` round, so `COUNT(DISTINCT episode WHERE status IN
 * ('passed','reset')) + 1` is both the count of ended episodes plus one and
 * the next episode number — the two are the same number.
 */
export function currentEpisode(
  store: Store,
  ticketId: number,
  sourceStage: RecoverySourceStage,
): number {
  const row = store.db
    .prepare(
      `SELECT COUNT(DISTINCT episode) AS ended FROM recovery_rounds
        WHERE ticket_id = ? AND source_stage = ?
          AND status IN ('passed','reset')`,
    )
    .get(ticketId, sourceStage) as { ended: number } | undefined;
  return (row?.ended ?? 0) + 1;
}

/**
 * The ticket's latest round for ONE source stage that is still ACTIVE —
 * a terminal round (passed/failed/exhausted/interrupted/refused/reset) is
 * history, not a series the driver can resume or the store can attach
 * revalidation to.
 */
export function activeRecoverySeries(
  store: Store,
  ticketId: number,
  sourceStage: RecoverySourceStage,
): RecoveryRound | null {
  const row = store.db
    .prepare(
      `${ROUND_SELECT} WHERE ticket_id = ? AND source_stage = ?
           AND status NOT IN ('passed','failed','exhausted','interrupted','refused','reset')
         ORDER BY id DESC LIMIT 1`,
    )
    .get(ticketId, sourceStage) as RecoveryRoundRow | undefined;
  return row === undefined ? null : rowToRound(row);
}

/**
 * The ticket's latest `interrupted` round for ONE source stage — the crash path
 * that consumed no additional round. An interrupt is NOT terminal history: the
 * driver may reopen it (see `reopenInterruptedRound`) when budget remains, so
 * this read exists for that decision rather than folding the round into the
 * active series (which must keep excluding it — a pending fix never reads as
 * crashed, and a crashed fix never reads as live).
 */
export function latestInterruptedRound(
  store: Store,
  ticketId: number,
  sourceStage: RecoverySourceStage,
): RecoveryRound | null {
  const row = store.db
    .prepare(
      `${ROUND_SELECT} WHERE ticket_id = ? AND source_stage = ? AND status = 'interrupted'
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
export function activeRoundAnyStage(store: Store, ticketId: number): RecoveryRound | null {
  const row = store.db
    .prepare(
      `${ROUND_SELECT} WHERE ticket_id = ? AND status = 'revalidating'
        ORDER BY id DESC LIMIT 1`,
    )
    .get(ticketId) as RecoveryRoundRow | undefined;
  return row === undefined ? null : rowToRound(row);
}

/** The round a Fix marker completes — the latest pending/fixing round. */
export function activeFixRound(store: Store, ticketId: number): RecoveryRound | null {
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

/** Every round recorded for a ticket, oldest first (insertion order is round order). */
export function listRecoveryRounds(store: Store, ticketId: number): RecoveryRound[] {
  return store.db
    .prepare(`${ROUND_SELECT} WHERE ticket_id = ? ORDER BY id`)
    .all(ticketId)
    .map((r) => rowToRound(r as RecoveryRoundRow));
}

export { RecoveryRoundRow, ROUND_SELECT, rowToRound };
