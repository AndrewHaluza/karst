import type { Store } from '../../store/db.js';
import type { BlockerKind, StageKey, StageRunResult, Verdict } from '../../model/types.js';
import { setStage, stageAttempt } from '../../store/stages.js';
import { recordGateRun, type GateRunInput } from '../../store/gateRuns.js';
import { parkGateStage, clearStageBlock } from '../../store/stageBlocks.js';
import { transition } from '../machine.js';

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
  const { ticketId, stageKey, runAt, artifactPath, gates, outcome } = input;

  if (outcome.kind === 'blocked') {
    parkGateStage(store, {
      ticketId,
      stageKey,
      kind: outcome.blocker,
      reason: outcome.reason,
      runAt,
      gates,
      artifactPath,
    });
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
        });
      }
      setStage(store, ticketId, stageKey, { artifactPath });
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
    });
  });
  return { kind: 'advanced', next };
}
