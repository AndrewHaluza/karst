import type { Store } from '../store/db.js';
import { STAGE_KEYS, type StageKey } from '../model/types.js';
import type { Manifest } from '../manifest/types.js';
import type { DriveProcessBundle } from '../agent/processAssignment.js';
import type { TesterGateRunner } from './uat/testerVerifier.js';
import type { HeadlessOutputChunk } from '../agent/headlessSpawn.js';
import type { GateOutputChunk } from './gates/run.js';
import type { InsideProgressEvent } from '../model/inside/progress.js';
import { getTicket } from '../store/tickets.js';
import {
  exhaustRecoveryRound,
  latestInterruptedRound,
  listRecoveryRounds,
  recoveryDecision,
  reopenInterruptedRound,
} from '../store/recoveryRounds.js';
import { nowIso } from '../model/time.js';
import { runStageDriver, type StageOutcome, type DriverStatus } from './driver.js';
import { runUat } from './stages/uat.js';
import { runReview, type OpenDiff } from './stages/review.js';
import {
  parkFixStage,
  FIX_PARKED_EXHAUSTED,
  FIX_PARKED_NO_FAILED_GATE,
  FIX_PARKED_NO_RESUMABLE_ROUND,
} from '../store/recoveryRounds.js';
import {
  capForGate,
  countFixAttempts,
  fixAttemptsRemain,
  lastFailedGate,
  roundFixDecision,
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
  resumeFix: (
    ticketId: number,
    gate: GateStageKey,
    attempts: number,
    /**
     * v30: the committed recovery round the fix answers. null for a ticket
     * parked at fix before rounds existed — the host then resumes untracked.
     */
    roundId: number | null,
    /**
     * The resolved Fix process bundle (Task 3): the `uat-fix`/`review-fix`
     * assignment snapshot and its instrumented adapter, resolved EXACTLY once
     * by the driver. NULL is the configured ABSENCE — the host logs and never
     * calls the session manager, so a disabled Fix process performs no nudge,
     * no launch and opens no process run; the pending round stays for a human.
     */
    process: DriveProcessBundle | null,
  ) => void;
  /**
   * Surfaces the ticket's changes for a human to review. Absent means nothing
   * does — review then records no 'changes' evidence for that run, and the
   * inside block shows no row rather than claim one nobody performed. The
   * host wires its existing ticket-stack surface here
   * (`TicketChangesManager.open`); that panel is itself backed by the
   * `openTicketDiff`/`vscode.diff` call already in `extension.ts`, but only
   * once a human clicks a file row inside it — this call alone does not open
   * a diff editor, only the panel. `driveTicket` never authors a second
   * surface of its own.
   */
  openDiff?: OpenDiff;
  /**
   * The Tester process (Task 8): its immutable assignment snapshot and the
   * already instrumented per-ticket adapter. Absent → no Tester runs at all;
   * UAT's ordinary gates (and the verifier, when configured) decide alone.
   * A function (not a bound value) because the host resolves it per-ticket
   * (a ticket's own `agentProvider` may differ from the manifest default) and
   * instruments it for token-usage attribution the same way every other AI
   * call in karst is (`agent/instrumentedAdapter.ts`). The driver calls it
   * EXACTLY once per run — the host's resolver builds a fresh instrumented
   * adapter per call, so a second call would instrument twice.
   */
  uatTester?: (ticketId: number) => DriveProcessBundle | null;
  /**
   * The Review findings process (Task 8): the same shape as `uatTester`,
   * resolving the `review` role's assignment and its instrumented adapter.
   * The findings lane opens its process run from this, snapshotting the
   * assignment; null → the lane falls back to the plain findings adapter
   * and opens no process run.
   */
  reviewProcess?: (ticketId: number) => DriveProcessBundle | null;
  /**
   * The configured Fix process (Task 3): the `uat-fix` / `review-fix` role's
   * assignment and instrumented adapter, resolved by the gate that failed
   * (`uat` → `uat-fix`, `review` → `review-fix`). Resolved EXACTLY once per
   * run, at the fix boundary — the host builds a fresh instrumented adapter
   * per call, so a second call would instrument twice. NULL is the configured
   * ABSENCE: `resumeFix` receives null and the host performs no launch, no
   * nudge and no process run, leaving the pending recovery round for a human.
   */
  fixProcess?: (ticketId: number, gate: GateStageKey) => DriveProcessBundle | null;
  /**
   * The host gate boundary for the optional `uat.testerVerifier` (Task 8) —
   * `runProcess` from `workflow/gates/run.ts`, injected so the stage never
   * spawns its own processes. Absent with a configured verifier, the UAT
   * stage parks; absent with no verifier configured, it is unused.
   */
  runVerifier?: TesterGateRunner;
  log: (message: string) => void;
  /**
   * Verbose decision-point logging (§ debug logging), prefixed `[driver]`,
   * threaded into the stage driver and the uat/review runners. Absent → no
   * debug lines. The host binds it to `Logger.debug` (a no-op unless the
   * manifest's `debug` flag is on) — deliberately distinct from `log`, which
   * is `Logger.info` and always writes.
   */
  debug?: (message: string) => void;
  /**
   * Where the findings lane's boundary diagnostics land (a failed AI call, an
   * unparseable response, an untrustworthy `file`) — threaded straight into
   * `ReviewDeps.warn`. Absent falls back all the way to `parseFindings`'s own
   * `console.warn` default; the host binds this to its `Logger.warn`, kept
   * distinct from `log` (which is `Logger.info`) so these read as warnings
   * in the output channel, not as routine progress lines.
   */
  warn?: (message: string) => void;
  /**
   * The host seam for the live inside progress overlay (Task 13): ONE generic
   * emitter the driver calls as gate processes start and finish. The host
   * forwards the event to the ticket's dashboard panel; the full snapshot that
   * follows remains authoritative. Absent → no live events, exactly the
   * pre-redesign behavior.
   */
  onInsideProgress?: (event: InsideProgressEvent) => void;
  /**
   * The host seam for a gate-lane AI process's LIVE output (Task 13): the
   * Tester's and findings lane's headless CLI calls stream decoded chunks here
   * as they arrive. RAW untrusted CLI prose — the host that surfaces it (the
   * console tail) must bound and sanitize it. Absent → no live chunks; the
   * settled output still lands in the process run/observations as before.
   */
  onAgentOutput?: (ticketId: number, processId: 'tester' | 'review', chunk: HeadlessOutputChunk) => void;
  /**
   * Live output from the DETERMINISTIC gate lane of a gate stage, chunk by
   * chunk, tagged with the stage and the gate that produced it. The host sink
   * (`GateConsole`) sanitizes it and pushes it to an OPEN stage console, so a
   * running gate is visible while it runs rather than only once its artifact
   * is written. RAW untrusted CLI prose at this seam.
   */
  onGateOutput?: (
    ticketId: number,
    stage: 'uat' | 'review',
    gateName: string,
    chunk: GateOutputChunk,
  ) => void;
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
  const ticket = getTicket(deps.store, ticketId);
  if (ticket.pausedAt !== null) {
    deps.debug?.(`[driver] ticket ${ticketId} is paused — skipping drive`);
    deps.log(`stage driver: ticket ${ticketId} is paused — skipping drive`);
    const stage: StageKey = (STAGE_KEYS.find((k) => k === ticket.stageCurrent) ?? 'scope') as StageKey;
    return { stage, status: 'paused' };
  }

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
        debug: deps.debug,
        // `runUat` reports its own StageRunResult, so it is passed through
        // verbatim: wrapping a park as 'advanced' at the ticket's unchanged
        // stage would send the driver round the same blocked gate forever.
        // The Tester process is resolved ONCE per run — the host's resolver
        // builds a fresh instrumented adapter per call, so calling it twice
        // would instrument twice (Task 8).
        runUat: (id, cwd) => {
          const tester = deps.uatTester?.(id) ?? undefined;
          return uat(
            deps.store,
            {
              ticketId: id,
              cwd,
              artifactDir: deps.artifactDirFor(id),
              manifest: deps.manifest(),
              signal: controller.signal,
              debug: deps.debug,
              onGateOutput: (name, chunk) => deps.onGateOutput?.(id, 'uat', name, chunk),
              onGateStart: (name) =>
                deps.onInsideProgress?.({
                  kind: 'active',
                  ticketId: id,
                  stage: 'uat',
                  processId: 'gates',
                  live: { status: 'run', label: name },
                }),
              onGateComplete: (name, exitCode) => {
                deps.onProgress(id, 'uat', 'running');
                deps.onInsideProgress?.({
                  kind: 'completed',
                  ticketId: id,
                  stage: 'uat',
                  process: {
                    id: 'gates',
                    kind: 'gates',
                    label: 'Gates',
                    status: exitCode === null ? 'note' : exitCode === 0 ? 'pass' : 'fail',
                    detail:
                      exitCode === null
                        ? `gate ${name} — nothing to run`
                        : `gate ${name} — exit ${exitCode}`,
                  },
                });
              },
              // Task 13: the Tester's headless output streams to the host's
              // console tail, and each target's progress rides the same
              // inside-progress overlay the gates use (the row stays 'run'
              // while more targets remain — the completed row is the
              // per-target outcome, never a terminal verdict). Debug lines
              // name the event and its size, never the CLI prose itself.
              onTesterOutput: (chunk) => {
                deps.debug?.(
                  `[driver] ticket ${id} tester output ${chunk.stream} +${chunk.text.length} chars`,
                );
                deps.onAgentOutput?.(id, 'tester', chunk);
              },
              onTesterTargetProgress: (event) => {
                if (event.status === 'active') {
                  deps.onInsideProgress?.({
                    kind: 'active',
                    ticketId: id,
                    stage: 'uat',
                    processId: 'tester',
                    live: { status: 'run', label: event.repo.slice(0, 200) },
                  });
                } else {
                  deps.onInsideProgress?.({
                    kind: 'completed',
                    ticketId: id,
                    stage: 'uat',
                    process: {
                      id: 'tester',
                      kind: 'tester',
                      label: 'Tester',
                      status: 'run',
                      detail: `${event.repo.slice(0, 120)} — ${(event.detail ?? 'done').slice(0, 80)}`,
                    },
                  });
                }
              },
            },
            { tester, runVerifier: deps.runVerifier },
          );
        },
        // `runReview` reports its own StageRunResult too, so it is passed
        // through verbatim for the same reason: a park re-labelled 'advanced'
        // at the ticket's unchanged stage sends the driver round the same
        // blocked gate forever. `deps.openDiff` is threaded straight through —
        // absent here means absent there, never a no-op default. The Review
        // findings process resolves ONCE per run, like the Tester above.
        runReview: (id, cwd) => {
          const reviewProcess = deps.reviewProcess?.(id);
          return review(
            deps.store,
            {
              ticketId: id,
              cwd,
              artifactDir: deps.artifactDirFor(id),
              manifest: deps.manifest(),
              signal: controller.signal,
              debug: deps.debug,
              onGateOutput: (name, chunk) => deps.onGateOutput?.(id, 'review', name, chunk),
              onGateStart: (name) =>
                deps.onInsideProgress?.({
                  kind: 'active',
                  ticketId: id,
                  stage: 'review',
                  processId: 'gates',
                  live: { status: 'run', label: name },
                }),
              onGateComplete: (name, exitCode) => {
                deps.onProgress(id, 'review', 'running');
                deps.onInsideProgress?.({
                  kind: 'completed',
                  ticketId: id,
                  stage: 'review',
                  process: {
                    id: 'gates',
                    kind: 'gates',
                    label: 'Gates',
                    status: exitCode === null ? 'note' : exitCode === 0 ? 'pass' : 'fail',
                    detail:
                      exitCode === null
                        ? `gate ${name} — nothing to run`
                        : `gate ${name} — exit ${exitCode}`,
                  },
                });
              },
              // Task 13: the findings lane's headless output streams to the
              // host's console tail, and each target's progress rides the same
              // inside-progress overlay the gates use (the row stays 'run'
              // while more targets remain — the completed row is the
              // per-target outcome, never a terminal verdict). Debug lines
              // name the event and its size, never the CLI prose itself.
              onFindingsOutput: (chunk) => {
                deps.debug?.(
                  `[driver] ticket ${id} review output ${chunk.stream} +${chunk.text.length} chars`,
                );
                deps.onAgentOutput?.(id, 'review', chunk);
              },
              onFindingsTargetProgress: (event) => {
                if (event.status === 'active') {
                  deps.onInsideProgress?.({
                    kind: 'active',
                    ticketId: id,
                    stage: 'review',
                    processId: 'review',
                    live: { status: 'run', label: event.repo.slice(0, 200) },
                  });
                } else {
                  deps.onInsideProgress?.({
                    kind: 'completed',
                    ticketId: id,
                    stage: 'review',
                    process: {
                      id: 'review',
                      kind: 'review',
                      label: 'Review',
                      status: 'run',
                      detail: `${event.repo.slice(0, 120)} — ${(event.detail ?? 'done').slice(0, 80)}`,
                    },
                  });
                }
              },
            },
            {
              openDiff: deps.openDiff,
              findingsAdapter: reviewProcess?.adapter,
              reviewProcess,
              warn: deps.warn,
            },
          );
        },
      },
      ticketId,
    );

    deps.log(
      `stage driver: ticket ${ticketId} halted at ${outcome.stage} (${outcome.status}` +
        `${outcome.reason ? `: ${outcome.reason}` : ''})`,
    );

    if (outcome.stage === 'fix') {
      const stages = getTicket(deps.store, ticketId).stages;
      // v30: a failed verdict commits its recovery round atomically, so the
      // driver reads the round id and its committed max_rounds back from the
      // store — the manifest knob may have changed since the failure, and the
      // decision must never be re-derived from it. The stages-attempt fallback
      // below exists only for tickets parked at fix before rounds did.
      const gate = lastFailedGate(stages);
      let round = gate === null ? null : recoveryDecision(deps.store, ticketId, gate);
      // An interrupted fix session consumes NO additional round — a crash within
      // budget is resumable, never terminal history. `activeRecoverySeries`
      // excludes `interrupted` rounds, so the reopen restores the round to
      // `pending` BEFORE the resume branch below reads it again. Bounded by
      // `interrupt_count < max_rounds` (v45): a crash never advances the round
      // number, so without this counter a fix that keeps dying without the
      // marker would be relaunched on every terminal close forever. Once the
      // round has crashed as many times as its budget allows, it stays
      // interrupted history and the terminal-rounds branch parks the ticket.
      if (round === null && gate !== null) {
        const interrupted = latestInterruptedRound(deps.store, ticketId, gate);
        if (
          interrupted !== null &&
          interrupted.interruptCount < interrupted.maxRounds &&
          roundFixDecision({
            roundId: interrupted.id,
            round: interrupted.round,
            maxRounds: interrupted.maxRounds,
          }).kind === 'resume'
        ) {
          reopenInterruptedRound(deps.store, ticketId, interrupted.id);
          round = recoveryDecision(deps.store, ticketId, gate);
          deps.debug?.(
            `[driver] ticket ${ticketId} at fix: reopened interrupted recovery round ${interrupted.round} ` +
              `(round id ${interrupted.id}, ${interrupted.interruptCount + 1} ` +
              `crash${interrupted.interruptCount + 1 === 1 ? '' : 'es'}, budget ${interrupted.maxRounds})`,
          );
        }
      }
      if (round !== null && round.status === 'pending') {
        // `round !== null` is only reachable when `gate` resolved, but the
        // correlation is not expressible to the type system.
        const resumingGate = gate as GateStageKey;
        const decision = roundFixDecision(round);
        if (decision.kind === 'resume') {
          deps.debug?.(
            `[driver] ticket ${ticketId} at fix: resuming round ${decision.attempts} ` +
              `(round id ${decision.roundId}, attempt ${decision.attempts + 1} of ${round.maxRounds})`,
          );
          // Task 3: the Fix process resolves EXACTLY once here, by the gate
          // that failed; the bundle (or its configured absence, null) rides the
          // resume call so the host snapshots the resolved identity instead of
          // re-resolving the role from live configuration.
          const fix = deps.fixProcess?.(ticketId, resumingGate) ?? null;
          deps.resumeFix(ticketId, resumingGate, decision.attempts, decision.roundId, fix);
        } else {
          // The budget is spent: the round becomes terminal state BEFORE the
          // ticket is handed to a human — an exhausted round is history, never
          // reconsidered, and a later drive reads it as such. Only the pending
          // round this ticket owns can transition; anything else is a no-op.
          exhaustRecoveryRound(deps.store, ticketId, decision.roundId, nowIso());
          deps.debug?.(
            `[driver] ticket ${ticketId} at fix: recovery round ${decision.attempts} exhausted ` +
              `(round id ${decision.roundId}, ${round.maxRounds} rounds)`,
          );
          deps.log(
            `stage driver: ticket ${ticketId} parked at fix — ${decision.attempts} ` +
              `${resumingGate} recovery rounds, at the cap of ${decision.cap}; leaving it for a human`,
          );
        }
      } else if (round !== null && round.status === 'fixing') {
        deps.debug?.(
          `[driver] ticket ${ticketId} at fix: recovery round ${round.round} already fixing — leaving it`,
        );
        deps.log(
          `stage driver: ticket ${ticketId} at fix with a fix execution already in flight ` +
            `(recovery round ${round.round}); leaving it`,
        );
      } else if (round !== null) {
        deps.debug?.(`[driver] ticket ${ticketId} at fix: round ${round.round} is ${round.status}`);
        deps.log(
          `stage driver: ticket ${ticketId} at fix with no resumable recovery round ` +
            `(${round.status}); leaving it`,
        );
        // The ticket rests at fix for a human — the stage row must stop reading
        // as if the agent were still fixing.
        parkFixStage(deps.store, ticketId, FIX_PARKED_NO_RESUMABLE_ROUND, nowIso());
      } else if (listRecoveryRounds(deps.store, ticketId).length > 0) {
        // Rounds exist but every one is terminal (exhausted/passed/failed/
        // interrupted) — history, never reconsidered. A v30 ticket whose
        // series exhausted is NOT untracked: falling back to the stages-attempt
        // decision would re-resume it against the live manifest with no round.
        deps.debug?.(`[driver] ticket ${ticketId} at fix: only terminal recovery rounds — leaving it`);
        deps.log(
          `stage driver: ticket ${ticketId} at fix with only terminal recovery rounds; leaving it`,
        );
        parkFixStage(deps.store, ticketId, FIX_PARKED_NO_RESUMABLE_ROUND, nowIso());
      } else {
        const decision = fixResumeDecision(stages, deps.manifest());
        switch (decision.kind) {
          case 'resume': {
            deps.debug?.(
              `[driver] ticket ${ticketId} at fix: resume fix for ${decision.gate} ` +
                `(attempt ${decision.attempts + 1})`,
            );
            const fix = deps.fixProcess?.(ticketId, decision.gate) ?? null;
            deps.resumeFix(ticketId, decision.gate, decision.attempts, null, fix);
            break;
          }
          case 'exhausted':
            deps.debug?.(
              `[driver] ticket ${ticketId} at fix: fix attempts exhausted for ${decision.gate} ` +
                `(${decision.attempts} of ${decision.cap})`,
            );
            deps.log(
              `stage driver: ticket ${ticketId} parked at fix — ${decision.attempts} ` +
                `${decision.gate} failures, at the cap of ${decision.cap}; leaving it for a human`,
            );
            parkFixStage(deps.store, ticketId, FIX_PARKED_EXHAUSTED, nowIso());
            break;
          case 'no-failed-gate':
            deps.debug?.(`[driver] ticket ${ticketId} at fix: no failed gate found`);
            deps.log(`stage driver: ticket ${ticketId} at fix with no failed gate; leaving it`);
            parkFixStage(deps.store, ticketId, FIX_PARKED_NO_FAILED_GATE, nowIso());
            break;
          default: {
            const unreachable: never = decision;
            throw new Error(`unrecognized fix resume decision: ${JSON.stringify(unreachable)}`);
          }
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
