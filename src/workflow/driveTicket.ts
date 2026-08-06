import type { Store } from '../store/db.js';
import type { StageKey } from '../model/types.js';
import type { Manifest } from '../manifest/types.js';
import type { AgentAdapter } from '../agent/adapter.js';
import { getTicket } from '../store/tickets.js';
import { runStageDriver, type StageOutcome, type DriverStatus } from './driver.js';
import { runUat } from './stages/uat.js';
import { runReview, type OpenDiff } from './stages/review.js';
import {
  capForGate,
  countFixAttempts,
  fixAttemptsRemain,
  lastFailedGate,
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
  // Each gate's budget is its own manifest key: `uat.maxFixAttempts` can never
  // narrow review's budget, nor `review.maxFixAttempts` uat's. The rule lives in
  // `capForGate` so the meter the dashboard draws and the budget spent here can
  // never be two different numbers.
  const cap = capForGate(gate, manifest?.uat?.maxFixAttempts, manifest?.review?.maxFixAttempts);
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
  /**
   * Surfaces the ticket's changes for a human to review. Absent means nothing
   * does — review then records no 'changes' evidence for that run, and
   * `reviewInside` shows no row rather than claim one nobody performed. The
   * host wires its existing ticket-stack surface here
   * (`TicketChangesManager.open`); that panel is itself backed by the
   * `openTicketDiff`/`vscode.diff` call already in `extension.ts`, but only
   * once a human clicks a file row inside it — this call alone does not open
   * a diff editor, only the panel. `driveTicket` never authors a second
   * surface of its own.
   */
  openDiff?: OpenDiff;
  /**
   * The agent core review's findings lane (Lane B) asks about the diff.
   * Absent means no agent core is available — `capability-missing` (spec
   * §8.14), never a failure. A function (not a bound value) because the host
   * resolves it per-ticket (a ticket's own `agentProvider` may differ from
   * the manifest default) and instruments it for token-usage attribution the
   * same way every other AI call in karst is (`agent/instrumentedAdapter.ts`).
   */
  agentAdapter?: (ticketId: number) => AgentAdapter;
  log: (message: string) => void;
  /**
   * Where the findings lane's boundary diagnostics land (a failed AI call, an
   * unparseable response, an untrustworthy `file`) — threaded straight into
   * `ReviewDeps.warn`. Absent falls back all the way to `parseFindings`'s own
   * `console.warn` default; the host binds this to its `Logger.warn`, kept
   * distinct from `log` (which is `Logger.info`) so these read as warnings
   * in the output channel, not as routine progress lines.
   */
  warn?: (message: string) => void;
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
            onGateComplete: () => deps.onProgress(id, 'uat', 'running'),
          }),
        // `runReview` reports its own StageRunResult too, so it is passed
        // through verbatim for the same reason: a park re-labelled 'advanced'
        // at the ticket's unchanged stage sends the driver round the same
        // blocked gate forever. `deps.openDiff` is threaded straight through —
        // absent here means absent there, never a no-op default.
        runReview: (id, cwd) =>
          review(
            deps.store,
            {
              ticketId: id,
              cwd,
              artifactDir: deps.artifactDirFor(id),
              manifest: deps.manifest(),
              signal: controller.signal,
              onGateComplete: () => deps.onProgress(id, 'review', 'running'),
            },
            { openDiff: deps.openDiff, findingsAdapter: deps.agentAdapter?.(id), warn: deps.warn },
          ),
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
