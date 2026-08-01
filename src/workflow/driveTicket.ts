import type { Store } from '../store/db.js';
import type { StageKey } from '../model/types.js';
import type { Manifest } from '../manifest/types.js';
import { getTicket } from '../store/tickets.js';
import { runStageDriver, type StageOutcome, type DriverStatus } from './driver.js';
import { runUat } from './stages/uat.js';
import { runReview } from './stages/review.js';
import {
  countFixAttempts,
  fixAttemptsRemain,
  lastFailedGate,
  FIX_ATTEMPT_CAP,
  type GateStageKey,
} from './fixAttempts.js';

export type FixResumeDecision =
  | { kind: 'resume'; gate: GateStageKey; attempts: number }
  | { kind: 'exhausted'; gate: GateStageKey; attempts: number; cap: number }
  | { kind: 'no-failed-gate' };

/**
 * Whether to resume the agent into `fix`, and against which budget.
 *
 * Pure, so the cap arithmetic is testable without a window: this is the decision
 * that used to live inline in `extension.ts` and summed two stages' attempts into
 * one counter.
 *
 * Exhaustion needs no new state. The ticket rests at `fix`, `resumeFix` is never
 * called, and `ticketsToSweep` does not select a ticket at `fix` — so it simply
 * stops, somewhere a human can act.
 */
export function fixResumeDecision(
  stages: readonly { stageKey: string; status?: string; endedAt?: string | null; attempt?: number }[],
  manifest: Manifest | undefined,
): FixResumeDecision {
  const gate = lastFailedGate(stages);
  if (!gate) return { kind: 'no-failed-gate' };
  // Only UAT's budget is configurable; review keeps the default until its own
  // redesign, so `uat.maxFixAttempts` can never narrow a gate it does not name.
  const cap = gate === 'uat' ? (manifest?.uat?.maxFixAttempts ?? FIX_ATTEMPT_CAP) : FIX_ATTEMPT_CAP;
  const attempts = countFixAttempts(stages, gate);
  return fixAttemptsRemain(attempts, cap)
    ? { kind: 'resume', gate, attempts }
    : { kind: 'exhausted', gate, attempts, cap };
}

export interface DriveTicketDeps {
  store: Store;
  manifest: () => Manifest | undefined;
  artifactDirFor: (ticketId: number) => string;
  worktreeFor: (ticketId: number) => string | null;
  onProgress: (ticketId: number, stage: StageKey, status: DriverStatus) => void;
  shouldContinue: () => boolean;
  /** The host's Stop, as a signal. Folded into this run's own controller. */
  signal?: AbortSignal;
  /** Called only when a fix attempt remains; the host owns how it resumes. */
  resumeFix: (ticketId: number, gate: GateStageKey, attempts: number) => void;
  log: (message: string) => void;
}

/**
 * Test seam. The runners are reached by module import, not by injection, because
 * production has exactly one implementation of each and threading them through
 * the host would put the wiring back where it cannot be tested. Overriding them
 * here lets a test drive one `StageRunResult` branch without a repository on disk.
 */
export interface DriveTicketRunners {
  runUat?: typeof runUat;
  runReview?: typeof runReview;
}

/**
 * Run the gates for one ticket and act on where it stopped.
 *
 * Lives here rather than in `extension.ts` because it is the only untested part
 * of the driver path and it is exactly where the `StageRunResult` branching
 * lands. Nothing in this module imports `vscode`.
 */
export async function driveTicket(
  deps: DriveTicketDeps,
  ticketId: number,
  runners: DriveTicketRunners = {},
): Promise<StageOutcome> {
  const uat = runners.runUat ?? runUat;
  const review = runners.runReview ?? runReview;

  // ONE controller for the whole run, threaded into every gate. Two things abort
  // it: the host's Stop signal, and the driver's own boundary poll — so a Stop
  // pressed during a fifteen-minute gate kills that child instead of being
  // noticed once it finishes on its own.
  const controller = new AbortController();
  const onHostAbort = (): void => controller.abort();
  if (deps.signal?.aborted) controller.abort();
  else deps.signal?.addEventListener('abort', onHostAbort, { once: true });

  const shouldContinue = (): boolean => {
    if (deps.shouldContinue()) return true;
    controller.abort();
    return false;
  };

  try {
    const outcome = await runStageDriver(
      {
        store: deps.store,
        worktreeFor: deps.worktreeFor,
        onProgress: deps.onProgress,
        shouldContinue,
        // `runUat` reports its own StageRunResult, so it is passed through
        // verbatim: wrapping a park as 'advanced' at the ticket's unchanged
        // stage would send the driver round the same blocked gate forever.
        runUat: (id, cwd) =>
          uat(deps.store, {
            ticketId: id,
            cwd,
            artifactDir: deps.artifactDirFor(id),
            manifest: deps.manifest(),
            signal: controller.signal,
          }),
        // `runReview` still always transitions and returns a ReviewOutcome, so
        // its result is adapted here from the ticket's post-transition stage.
        // Review's redesign is out of scope for this phase.
        runReview: (id, cwd) =>
          review(deps.store, {
            ticketId: id,
            cwd,
            artifactDir: deps.artifactDirFor(id),
            manifest: deps.manifest(),
          }).then(() => ({
            kind: 'advanced' as const,
            next: getTicket(deps.store, id).stageCurrent as StageKey,
          })),
      },
      ticketId,
    );

    deps.log(
      `stage driver: ticket ${ticketId} halted at ${outcome.stage} (${outcome.status}` +
        `${outcome.reason ? `: ${outcome.reason}` : ''})`,
    );

    if (outcome.stage === 'fix') {
      const decision = fixResumeDecision(getTicket(deps.store, ticketId).stages, deps.manifest());
      switch (decision.kind) {
        case 'resume':
          deps.resumeFix(ticketId, decision.gate, decision.attempts);
          break;
        case 'exhausted':
          deps.log(
            `stage driver: ticket ${ticketId} parked at fix — ${decision.attempts} ` +
              `${decision.gate} failures, at the cap of ${decision.cap}; leaving it for a human`,
          );
          break;
        case 'no-failed-gate':
          deps.log(`stage driver: ticket ${ticketId} at fix with no failed gate; leaving it`);
          break;
        default: {
          const unreachable: never = decision;
          throw new Error(`unrecognized fix resume decision: ${JSON.stringify(unreachable)}`);
        }
      }
    }

    return outcome;
  } finally {
    // The host signal outlives this run; leaving the listener on it would leak
    // one per driver run for the window's lifetime.
    deps.signal?.removeEventListener('abort', onHostAbort);
  }
}
