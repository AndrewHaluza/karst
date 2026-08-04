import type { Store } from '../../store/db.js';
import type { BlockerKind, StageKey, StageRunResult, Verdict } from '../../model/types.js';
import { setStage, stageAttempt } from '../../store/stages.js';
import { recordGateRun, type GateRunInput } from '../../store/gateRuns.js';
import { recordFindings, type FindingInput } from '../../store/reviewFindings.js';
import { parkGateStage, clearStageBlock } from '../../store/stageBlocks.js';
import { closeStageRun, type StageRunOutcome } from '../../store/stageRuns.js';
import { transition } from '../machine.js';
import { nowIso } from '../../model/time.js';

/** What a gate run decided, before any of it is written down. */
export type RunOutcome =
  | { kind: 'verdict'; verdict: Exclude<Verdict, null> }
  | { kind: 'blocked'; blocker: BlockerKind; reason: string }
  | { kind: 'stopped' };

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
  /** Clock for the run's `ended_at`; injected so tests are deterministic. */
  now?: () => string;
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
  store: Store,
  input: CommitGateOutcomeInput,
): StageRunResult {
  const { ticketId, stageKey, runAt, artifactPath, gates, outcome, findings, stageRunId } =
    input;
  const now = input.now ?? nowIso;

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
    closeRun('advanced');
  });
  return { kind: 'advanced', next };
}
