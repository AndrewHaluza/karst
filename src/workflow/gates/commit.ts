import type { NestableStore } from '../../store/db.js';
import type { BlockerKind, StageKey, StageRunResult, Verdict } from '../../model/types.js';
import { setStage, stageAttempt } from '../../store/stages.js';
import { recordGateRun, type GateRunInput } from '../../store/gateRuns.js';
import { recordFindings, type FindingInput } from '../../store/reviewFindings.js';
import { parkGateStage, clearStageBlock } from '../../store/stageBlocks.js';
import { closeStageRun, type StageRunOutcome } from '../../store/stageRuns.js';
import {
  openRecoveryRound,
  completeRevalidation,
  type RecoverySourceProcessId,
  type RecoverySourceStage,
  type RecoveryTriggerKind,
} from '../../store/recoveryRounds.js';
import { transition } from '../machine.js';
import { nowIso } from '../../model/time.js';

/** What a gate run decided, before any of it is written down. */
export type RunOutcome =
  | { kind: 'verdict'; verdict: Exclude<Verdict, null> }
  | { kind: 'blocked'; blocker: BlockerKind; reason: string }
  | { kind: 'stopped' };

/**
 * The closed call-site payload that opens a recovery round (v30): the complete
 * causal snapshot of a gate failure, captured where the failing evidence, the
 * current stage run and the manifest cap are all still in hand — UAT/Review
 * construct it BEFORE calling `commitGateOutcome`. Never reconstructed later
 * from `stages.verdict`, latest findings, or mutable Settings.
 *
 * `sourceProcessId` names the process that produced the failure ('gates' for a
 * deterministic gate, 'tester' for a verifier exit, 'review' for the findings
 * lane); `sourceProcessRunId` is that process's run when the source was an AI
 * process (Tester/Review), null otherwise — one id column, one table identity.
 * `maxRounds` is the fix budget the failure committed under.
 */
export type RecoveryTriggerInput = {
  sourceProcessId: RecoverySourceProcessId;
  sourceStageRunId: number;
  sourceProcessRunId: number | null;
  triggerKind: RecoveryTriggerKind;
  triggerDetail: string;
  maxRounds: number;
};

export interface CommitGateOutcomeInput {
  ticketId: number;
  stageKey: StageKey;
  /** The batch stamp every gate row of this invocation shares. */
  runAt: string;
  artifactPath: string;
  /** Whatever evidence exists. Empty is legitimate — nothing ran. */
  gates: readonly GateRunInput[];
  outcome: RunOutcome;
  /**
   * Review's Lane B evidence for this run (empty/absent for every other gate
   * stage — `uat.ts` never passes this). Recorded in the SAME transaction as
   * the outcome below, exactly like `gates`: findings are append-only
   * evidence just like `gate_runs`, and a verdict must never commit separately
   * from what produced it.
   */
  findings?: readonly FindingInput[];
  /**
   * v25: the `stage_runs` row this outcome closes, when the caller opened one.
   *
   * A caller that opened a run has ALREADY written its evidence, gate by gate,
   * as each one finished — so `gates` here is whatever is still unwritten
   * (normally empty) and this id is what turns the open run into a finished
   * one. Closing it is folded into the same transaction as the outcome: a run
   * marked finished beside a stage that never committed its verdict would be
   * the same lie, pointing the other way.
   *
   * Absent = the caller opened no run. Nothing is invented on this side.
   */
  stageRunId?: number | null;
  /**
   * v30: the recovery trigger for a FAILED verdict. Legal only with a failed
   * verdict from a gate stage — and a failed verdict that enters automatic
   * recovery MUST carry one. The round opens inside the verdict's transaction,
   * so the failing verdict, its recorded evidence and the round commit
   * atomically (or not at all).
   */
  recoveryTrigger?: RecoveryTriggerInput;
  /** Clock for the run's `ended_at`; injected so tests are deterministic. */
  now?: () => string;
  /**
   * Verbose decision-point logging (§ debug logging), prefixed `[gate]`.
   * Absent → no debug lines; the host binds it to `Logger.debug` (a no-op
   * unless the manifest's `debug` flag is on).
   */
  debug?: (message: string) => void;
}

/**
 * The ONE place a gate run is written down, for every gate stage.
 *
 * Shared rather than mirrored per stage on purpose: the three branches below are
 * the transactional invariants CLAUDE.md singles out — `gate_runs` has exactly
 * two writers and both read `attempt` BEFORE any bump, `clearStageBlock` runs
 * inside the verdict's transaction, and a park or a Stop consumes no attempt.
 * Two copies of that differing only in a stage-key literal is the worst possible
 * place for a correction to land on one side and not the other. `uat.ts` and
 * `review.ts` held exactly such a pair.
 *
 * Evidence and outcome commit together on every path, because a stopped or
 * blocked run still produced gate rows worth keeping and `gate_runs` is the
 * project's only append-only evidence table.
 */
export function commitGateOutcome(
  store: NestableStore,
  input: CommitGateOutcomeInput,
): StageRunResult {
  const { ticketId, stageKey, runAt, artifactPath, gates, outcome, findings, stageRunId } =
    input;
  const now = input.now ?? nowIso;
  input.debug?.(
    `[gate] ${stageKey} ticket ${ticketId}: committing outcome ` +
      (outcome.kind === 'verdict'
        ? `verdict ${outcome.verdict.kind}`
        : outcome.kind === 'blocked'
          ? `blocked (${outcome.blocker}: ${outcome.reason})`
          : 'stopped'),
  );

  // The recovery trigger is validated against the actual outcome BEFORE
  // anything mutates: a trigger is legal only with a failed verdict from a gate
  // stage, and a failed verdict that enters automatic recovery (the fix loop)
  // must carry one — otherwise the ticket would enter fix with no committed
  // round for the driver to read back.
  const isGate = stageKey === 'uat' || stageKey === 'review';
  if (input.recoveryTrigger !== undefined) {
    if (!isGate || outcome.kind !== 'verdict' || outcome.verdict.kind !== 'failed') {
      const kind =
        outcome.kind === 'verdict' ? `verdict/${outcome.verdict.kind}` : outcome.kind;
      throw new Error(
        `recovery trigger supplied for a ${kind} outcome at '${stageKey}' — ` +
          'a trigger is only legal with a failed verdict from uat/review',
      );
    }
  } else if (isGate && outcome.kind === 'verdict' && outcome.verdict.kind === 'failed') {
    throw new Error(
      `a failed verdict at '${stageKey}' must carry a recovery trigger — ` +
        'automatic recovery enters fix, and the round is what the driver reads back',
    );
  }

  /** Close the caller's run, if it opened one. Always inside a transaction below. */
  const closeRun = (kind: StageRunOutcome): void => {
    if (stageRunId === undefined || stageRunId === null) return;
    closeStageRun(store, stageRunId, kind, now());
  };

  // Findings share the batch's `runAt` and the same pre-bump `attempt` gates
  // read — recorded from inside whichever transaction below actually commits,
  // never on its own, so a batch never lands without the outcome it belongs to.
  const recordFindingsIfAny = (): void => {
    if (!findings || findings.length === 0) return;
    recordFindings(store, {
      ticketId,
      attempt: stageAttempt(store, ticketId, stageKey),
      runAt,
      findings,
    });
  };

  if (outcome.kind === 'blocked') {
    const apply = store.db.transaction(() => {
      parkGateStage(store, {
        ticketId,
        stageKey,
        kind: outcome.blocker,
        reason: outcome.reason,
        runAt,
        gates,
        artifactPath,
        stageRunId,
      });
      recordFindingsIfAny();
      closeRun('blocked');
    });
    apply();
    return { kind: 'blocked', blocker: outcome.blocker, reason: outcome.reason };
  }

  if (outcome.kind === 'stopped') {
    // No verdict, no attempt, no block — but whatever finished still happened.
    const apply = store.db.transaction(() => {
      if (gates.length > 0) {
        recordGateRun(store, {
          ticketId,
          stageKey,
          attempt: stageAttempt(store, ticketId, stageKey),
          runAt,
          gates,
          stageRunId,
        });
      }
      recordFindingsIfAny();
      setStage(store, ticketId, stageKey, { artifactPath });
      closeRun('stopped');
    });
    apply();
    return { kind: 'stopped' };
  }

  const next = transition(store, ticketId, stageKey, outcome.verdict, () => {
    setStage(store, ticketId, stageKey, { artifactPath });
    // A run that reached a verdict answers whatever blocked a previous one.
    clearStageBlock(store, ticketId, stageKey);
    recordGateRun(store, {
      ticketId,
      stageKey,
      // Read before the machine bumps it on a failure: these gates belong to the
      // attempt that RAN, not to the one its failure creates.
      attempt: stageAttempt(store, ticketId, stageKey),
      runAt,
      gates,
      stageRunId,
    });
    recordFindingsIfAny();
    // v30: the recovery round opens INSIDE the verdict's transaction, carrying
    // the complete causal snapshot the caller captured — the failing verdict,
    // its evidence and the round commit together or not at all. A revalidation
    // run that fails fails the active round here too (the round it revalidates
    // was attached when that run opened), and the new round describes the new
    // cause.
    if (input.recoveryTrigger !== undefined) {
      openRecoveryRound(store, {
        ticketId,
        sourceStage: stageKey as RecoverySourceStage,
        sourceProcessId: input.recoveryTrigger.sourceProcessId,
        sourceStageRunId: input.recoveryTrigger.sourceStageRunId,
        sourceProcessRunId: input.recoveryTrigger.sourceProcessRunId,
        triggerKind: input.recoveryTrigger.triggerKind,
        triggerDetail: input.recoveryTrigger.triggerDetail,
        maxRounds: input.recoveryTrigger.maxRounds,
        startedAt: now(),
      });
    } else if (outcome.verdict.kind === 'passed' && stageRunId !== undefined && stageRunId !== null) {
      // A passed revalidation completes the round whose run this is — for a
      // review-origin round only its own review outcome completes it.
      completeRevalidation(store, {
        ticketId,
        stageKey: stageKey as RecoverySourceStage,
        stageRunId,
        endedAt: now(),
      });
    }
    closeRun('advanced');
  });
  return { kind: 'advanced', next };
}
