import type { Store } from '../../store/db.js';
import type { StageKey } from '../../model/types.js';
import type { Manifest } from '../../manifest/types.js';
import { recordGateRun, type GateRunInput } from '../../store/gateRuns.js';
import { recordFindings, type FindingInput } from '../../store/reviewFindings.js';
import { openStageRun } from '../../store/stageRuns.js';
import { stageAttempt } from '../../store/stages.js';
import { gateRevision } from '../../manifest/gateRevision.js';

/**
 * A gate run's DURABLE handle: opened before the first gate starts, written to
 * as each piece of evidence appears, closed by `commitGateOutcome`.
 *
 * Shared by `uat.ts` and `review.ts` for the same reason `commitGateOutcome` is
 * — the ordering rules here are invariants, and a copy per stage is where a
 * correction lands on one side only.
 *
 * The rule it enforces: **evidence is written when it happens, not when the run
 * ends.** A run used to collect every gate result in memory and commit the lot
 * inside `finish()`, so an extension-host restart mid-run discarded all of it —
 * gate results, and a findings lane that had already cost 1.3M tokens. Process
 * death fires no `AbortSignal`, so the `stopped` path cannot cover it; nothing
 * runs at all. The only thing that survives a killed process is what is already
 * on disk.
 *
 * `attempt` is read ONCE, when the run opens, and every row of the run carries
 * it — the same pre-bump value the end-of-run write used to read, now captured
 * before any gate can fail rather than after.
 */
export interface GateRunEvidence {
  /** The `stage_runs` row id, handed to `commitGateOutcome` to close. */
  readonly runId: number;
  /** The stage's attempt when the run opened; every row is filed under it. */
  readonly attempt: number;
  /** Append gate rows NOW. Called as each gate finishes, never batched to the end. */
  append(rows: readonly GateRunInput[]): void;
  /**
   * Persist review's Lane B findings NOW, the moment the lane returns and
   * before anything is aggregated. These are completed model output that was
   * already paid for; holding them until the verdict is what threw away a run's
   * worth of tokens with nothing to show for it.
   */
  appendFindings(findings: readonly FindingInput[]): void;
}

export interface OpenGateRunInput {
  ticketId: number;
  stageKey: StageKey;
  /** The batch stamp shared by every row of this invocation. */
  runAt: string;
  /**
   * Hashed into the run's `manifest_hash` so a later reader can say the gate
   * SET changed between attempts. Absent (no manifest) records no hash rather
   * than a hash of nothing.
   */
  manifest?: Manifest;
  /** This process, so an activation sweep can tell a dead run from a live one. */
  pid?: number | null;
}

export function openGateRun(store: Store, input: OpenGateRunInput): GateRunEvidence {
  const { ticketId, stageKey, runAt } = input;
  const attempt = stageAttempt(store, ticketId, stageKey);
  const runId = openStageRun(store, {
    ticketId,
    stageKey,
    attempt,
    runAt,
    manifestHash: gateRevision(input.manifest),
    pid: input.pid ?? null,
    startedAt: runAt,
  });

  return {
    runId,
    attempt,
    append(rows) {
      if (rows.length === 0) return;
      recordGateRun(store, { ticketId, stageKey, attempt, runAt, gates: rows, stageRunId: runId });
    },
    appendFindings(findings) {
      if (findings.length === 0) return;
      recordFindings(store, { ticketId, attempt, runAt, findings });
    },
  };
}
