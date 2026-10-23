import type { Store } from '../store/db.js';
import type { StageRunResult, StageKey, BlockerKind } from '../model/types.js';
import type { Manifest, AgentProvider } from '../manifest/types.js';
import type { AgentAdapter } from '../agent/adapter.js';
import type { ProcessAssignmentSnapshot } from '../agent/processAssignment.js';
import {
  claimUsageLimitPark,
  reopenUsageLimitPark,
  type UsageLimitParkRow,
} from '../store/usageLimitParks.js';
import { usageLimitReason } from '../agent/cliFailure.js';
import { openGateRun } from './gates/evidence.js';
import { commitGateOutcome, type RecoveryTriggerInput } from './gates/commit.js';
import { closeStageRun } from '../store/stageRuns.js';
import { defaultGitRunner, type GitRunner } from '../integrations/git.js';
import type { ReviewArtifacts } from './review/conformance.js';
import { capForGate, type GateStageKey } from './fixAttempts.js';
import { nowIso } from '../model/time.js';
import { stageAttempt } from '../store/stages.js';
import { runReview } from './stages/review.js';
import { runUat } from './stages/uat.js';
import { parseUatKeptOutcome } from './uat/keptOutcome.js';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import {
  listWorktreesByTicket,
  listServersByTicket,
  type WorktreeView,
} from '../store/dashboard.js';
import { runnableSubset, unitsOfRepos } from '../manifest/runnable.js';
import { SpinCancelledError } from '../runtime/spin.js';
import type { UatSpin, UatStopServers } from './stages/uat.js';
import {
  runFindingsLane,
  type FindingsLaneTarget,
  type FindingsProcessInput,
} from './review/findingsLane.js';
import { listFindings, findingsForAttempt, type FindingInput } from '../store/reviewFindings.js';
import {
  aggregateReview,
  DEFAULT_REVIEW_FINDINGS,
  DEFAULT_REQUIRE_INDEPENDENT_SIGNAL,
  uatIdentitiesFrom,
  FINDINGS_FAILURE_PREFIX,
  gateEntriesFrom,
  type AggregateEntry,
  type FindingsLaneOutcome,
} from './review/aggregate.js';
import { listGateRuns, type GateRun } from '../store/gateRuns.js';
import { parkGateStage } from '../store/stageBlocks.js';
import {
  aggregateUat,
  reviewIdentitiesFrom,
  type AggregateOutcome,
} from './uat/aggregate.js';
import { finishProcessRun, listProcessRuns, setProcessRunResultKind } from '../store/processRuns.js';
import { collapseDiagnostic } from '../model/diagnosticText.js';
import {
  runUatTester,
  countBlockingObservations,
} from './uat/tester.js';
import { testerTargets } from './stages/uat.js';
import { listUatFindings, recordUatFindings, type UatFindingInput } from '../store/uatFindings.js';
import { getTicket } from '../store/tickets.js';
import {
  runTesterVerifier,
  TESTER_VERIFIER_FAILURE_PREFIX,
  TESTER_OBSERVATIONS_FAILURE_PREFIX,
  type TesterGateRunner,
} from './uat/testerVerifier.js';
import { laneTargetsToAsk, type KeptTarget } from './usageLimitKept.js';
import { parseReviewKeptOutcome, mergeReviewKeptOutcome } from './review/keptOutcome.js';
import { targetTree, unresolvedTargets } from './rerunTargets.js';
import { latestBaselineDecisions } from '../store/baselineDecisions.js';
import { unapprovedBaselines } from './gates/baselineReview.js';
import { detectTicketBaselines } from './gates/baselineReviewTicket.js';

export interface DismissParkOptions {
  manifest?: Manifest;
  artifactDir?: string;
  now?: () => string;
  debug?: (m: string) => void;
}

/**
 * Dismiss a usage-limit park.
 * - For op parks (no stage-block), claims the park row as 'dismiss' and returns { kind: 'stopped' }.
 * - For stage-block parks:
 *   1. Claims the park row atomically. If not claimed (e.g. concurrent claim), returns { kind: 'stopped' }.
 *   2. Opens its OWN new stage run via `openGateRun` (never the bare `openStageRun`).
 *   3. Commits a failed verdict via commitGateOutcome with a recoveryTrigger of triggerKind: 'usage-limit-dismissed'.
 */
export function dismissUsageLimitPark(
  store: Store,
  park: UsageLimitParkRow,
  opts: DismissParkOptions = {},
): StageRunResult {
  const now = opts.now ?? nowIso;
  const artifactDir = opts.artifactDir ?? '';

  const claimResult = claimUsageLimitPark(store, park.id, 'dismiss', now());
  if (!claimResult.claimed) {
    opts.debug?.(`[usageLimit] park ${park.id} already claimed or invalid`);
    return { kind: 'stopped' };
  }

  if (park.kind === 'op' || !park.stage) {
    return { kind: 'stopped' };
  }

  const stageKey = park.stage as GateStageKey;
  const runAt = now();

  // Opened with the SHARED gate-run handle, never the bare `openStageRun`,
  // for the same reason the re-runs are: `openGateRun` attaches a run opened
  // while a recovery round awaits its revalidation to that round
  // (`attachRevalidationStageRun`). The park being dismissed is normally that
  // revalidation — the fix → UAT/Review revalidation → quota park path leaves
  // the parked run's id in the round's `*_revalidation_stage_run_id` — and
  // `openRecoveryRound` fails the round it revalidates by matching that column
  // against `sourceStageRunId` (`revalidatesThisRound`). A bare run is never
  // attached, so the prior round would stay `'revalidating'` forever while a
  // SECOND round opened, breaking the one-active-round invariant.
  const evidence = openGateRun(store, {
    ticketId: park.ticketId,
    stageKey,
    runAt,
    manifest: opts.manifest,
    pid: process.pid,
    debug: opts.debug,
  });
  const newStageRunId = evidence.runId;

  if (artifactDir) {
    mkdirSync(artifactDir, { recursive: true });
    const artifactPath = join(artifactDir, `${stageKey}-ticket-${park.ticketId}-${newStageRunId}.log`);
    writeFileSync(artifactPath, `! usage limit dismissed: ${park.detail}\n`);
  }
  const artifactPath = artifactDir
    ? join(artifactDir, `${stageKey}-ticket-${park.ticketId}-${newStageRunId}.log`)
    : '';

  const sourceProcessId = park.lane === 'uat' ? 'tester' : 'review';
  const maxRounds = capForGate(
    stageKey,
    opts.manifest?.uat?.maxFixAttempts,
    opts.manifest?.review?.maxFixAttempts,
  );

  return commitGateOutcome(store, {
    ticketId: park.ticketId,
    stageKey,
    runAt,
    artifactPath,
    gates: [],
    outcome: {
      kind: 'verdict',
      verdict: { kind: 'failed', reason: park.detail },
    },
    stageRunId: newStageRunId,
    recoveryTrigger: {
      sourceProcessId,
      sourceStageRunId: newStageRunId,
      sourceProcessRunId: null,
      triggerKind: 'usage-limit-dismissed',
      triggerDetail: park.detail,
      maxRounds,
    },
    now,
    debug: opts.debug,
  });
}

export interface RerunParkOptions {
  store: Store;
  parkRow: UsageLimitParkRow;
  provider: AgentProvider;
  model: string | null;
  /**
   * A prebuilt adapter. Prefer `buildAdapter`: the claim must win BEFORE this
   * run's adapter is built, so a losing concurrent action touches nothing. This
   * field stays for callers that already own an adapter (and tests).
   */
  adapter?: AgentAdapter;
  /**
   * Build the per-run adapter from the CLAIMED row's provider/model. Invoked
   * only after `claimUsageLimitPark` wins, never for a loser.
   */
  buildAdapter?: (provider: AgentProvider, model: string | null) => AgentAdapter;
  /**
   * Resolve the role's per-run assignment (the profile `instructions`, the
   * `effort` and the display `agentName`) from the picked provider/model. The
   * override changes WHO runs the lane, never the role's prompt: dropping the
   * instructions would ask the new core a generic question and the effort/name
   * would lie in the process-run snapshot. Absent → the minimal identity, for
   * callers that own only an adapter (and tests).
   */
  resolveAssignment?: (
    stageKey: GateStageKey,
    provider: AgentProvider,
    model: string | null,
  ) => ProcessAssignmentSnapshot | undefined;
  manifest?: Manifest;
  resolution?: string;
  cwd: string;
  artifactDir: string;
  signal?: AbortSignal;
  now?: () => string;
  debug?: (m: string) => void;
  /**
   * The git runner the review re-run snapshots the worktree with. Absent → no
   * snapshot, and the findings prompt falls back to the branch range (exactly
   * like `runFindingsLane` when its own `git` is absent). The host supplies the
   * production runner; a unit test that leaves it absent spawns no git.
   */
  git?: GitRunner;
  /**
   * The review conformance artifacts (`intent`/`spec`/`plan`) the re-run judges
   * the change against. Absent, or a rejection, runs the lane as before — never
   * a stage failure. Loaded by the caller because the read touches the store.
   */
  loadArtifacts?: () => Promise<ReviewArtifacts | undefined>;
  /**
   * The fallback-path wording selector when no snapshot could be made (the
   * manifest's `review.openChanges`). Does NOT gate snapshot creation.
   */
  openChanges?: boolean;
  /**
   * The optional `uat.testerVerifier` host gate boundary — `runProcess` from
   * `workflow/gates/run.ts`. The stage runs the deterministic verifier AFTER the
   * Tester and BEFORE deciding; the re-run must too, or a passing re-run would
   * bypass the exit-code invariant. Absent with a configured verifier → the
   * verifier could not be asked, so the re-run parks `capability-missing`.
   */
  runVerifier?: TesterGateRunner;
  /**
   * The same composed `karst context` prefix the stage is handed. The Tester's
   * tier-1 pointer line names one command; a re-run that dropped it would ask a
   * weaker question than the run it replaces.
   */
  contextCommand?: string;
  /**
   * The driver's sandbox preflight (`driveTicket`'s `syncSandbox`), run before
   * the lane: for a sandboxed ticket the host worktree only holds the sandbox's
   * work after this sync, so a re-run that skipped it would review a stale tree.
   * A refusal parks `sandbox-sync`/`sandbox-setup` and runs nothing. Absent (a
   * host ticket, a unit test) → no preflight.
   */
  syncSandbox?: (ticketId: number) => Promise<{ ok: true } | { ok: false; reason: string }>;
  /** `driveTicket`'s `provisionSandbox`: the sandbox must be usable before the lane. */
  provisionSandbox?: (
    ticketId: number,
    signal?: AbortSignal,
  ) => Promise<{ ok: true } | { ok: false; reason: string }>;
  /**
   * Start the ticket's runnable services before the Tester, exactly like the
   * UAT stage (D155). Without it a browser re-run is told its change is not
   * live even though the stage would have started the app. Absent, or no
   * runnable repository in scope, or no matching `stopServers` → no spin, no
   * stop. A spin failure parks `boot-failed`; a cancel is a Stop.
   */
  spin?: UatSpin;
  /**
   * Stop the stack THIS re-run started, on every exit path. A stack the user
   * already started is theirs and is left alone (mirrors `UatDeps.stopServers`).
   */
  stopServers?: UatStopServers;
  /**
   * Finds the visual baselines the ticket changed (`uat.baselineReview`). The UAT
   * stage blocks on an unapproved one before its Tester; the re-run must too, or
   * a retry after the tree changed would pass the ticket on its own screenshots.
   */
  detectBaselines?: typeof detectTicketBaselines;
}

/**
 * The per-run identity: the role-resolved snapshot (instructions/effort/name)
 * with the picked provider/model forced on top. The pick wins over whatever the
 * resolver read from the ticket, exactly like the parked op's one-shot override.
 */
function assignmentFor(
  resolve: RerunParkOptions['resolveAssignment'],
  stageKey: GateStageKey,
  provider: AgentProvider,
  model: string | null,
): ProcessAssignmentSnapshot {
  return {
    ...(resolve?.(stageKey, provider, model) ?? {}),
    provider,
    ...(model !== null ? { model } : {}),
  };
}

/**
 * The result of a one-shot re-run. `alreadyHandled` distinguishes the pre-run
 * no-ops (the park was claimed by another window, or names no lane this path
 * can run) from a run the USER stopped: a Stop carries opened, closed and
 * interrupted rows that the dashboard must refresh, and calling it "already
 * handled" both lies and leaves the panel stale.
 */
export type RerunParkResult = StageRunResult & { alreadyHandled?: true };

/** The options a re-run uses once the claim won and its adapter exists. */
type ClaimedRerunOptions = RerunParkOptions & {
  adapter: AgentAdapter;
  assignment: ProcessAssignmentSnapshot;
};

/**
 * Park the stage on a block that is decided BEFORE the lane runs: a target with
 * no registered worktree (`nothing-to-run`), or a UAT baseline the user has not
 * approved (`baseline-review`, `capability-missing` when git cannot answer).
 *
 * Committed as a BLOCK through the shared outcome writer, never run against a
 * guessed tree: the one-shot was spent and the stage is left with an actionable,
 * resumable reason instead of a review/UAT of the wrong checkout wearing the
 * target's name.
 */
function commitBlockedRerun(args: {
  store: Store;
  ticketId: number;
  stageKey: GateStageKey;
  runAt: string;
  artifactDir: string;
  stageRunId: number;
  lane: 'review' | 'uat';
  blocker?: 'nothing-to-run' | 'baseline-review' | 'capability-missing';
  reason: string;
  now: () => string;
  debug?: (m: string) => void;
}): StageRunResult {
  const artifactPath = args.artifactDir
    ? join(args.artifactDir, `${args.lane}-ticket-${args.ticketId}-${args.stageRunId}.log`)
    : '';
  if (artifactPath) {
    mkdirSync(args.artifactDir, { recursive: true });
    writeFileSync(artifactPath, `! ${args.reason}\n`);
  }
  return commitGateOutcome(args.store, {
    ticketId: args.ticketId,
    stageKey: args.stageKey,
    runAt: args.runAt,
    artifactPath,
    gates: [],
    outcome: { kind: 'blocked', blocker: args.blocker ?? 'nothing-to-run', reason: args.reason },
    stageRunId: args.stageRunId,
    now: args.now,
    debug: args.debug,
  });
}

/**
 * Commit a parked UAT run's own gate outcome when it is not a pass/bypass.
 *
 * The stage never reaches its Tester with a gate that blocked or failed, so a
 * re-run must not either. The verdict's causal source is `gates` (no AI process
 * ran), exactly like the stage's `recoveryTriggerFor`, so the fix round is
 * attributed to the gates and not to a Tester that never spoke.
 */
function commitParkedGateOutcome(args: {
  store: Store;
  parkRow: UsageLimitParkRow;
  stageKey: GateStageKey;
  runAt: string;
  artifactDir: string;
  stageRunId: number;
  manifest: Manifest | undefined;
  gateOutcome: AggregateOutcome;
  now: () => string;
  debug?: (m: string) => void;
}): StageRunResult {
  const artifactPath = args.artifactDir
    ? join(args.artifactDir, `uat-ticket-${args.parkRow.ticketId}-${args.stageRunId}.log`)
    : '';
  const decided =
    args.gateOutcome.kind === 'blocked'
      ? args.gateOutcome.reason
      : args.gateOutcome.verdict.kind === 'failed'
        ? (args.gateOutcome.verdict.reason ?? 'gates failed')
        : 'gates did not pass';
  if (artifactPath) {
    mkdirSync(args.artifactDir, { recursive: true });
    writeFileSync(
      artifactPath,
      `! re-run parked uat: the parked run's gates decided before the Tester\n! ${decided}\n`,
    );
  }
  const failedVerdict =
    args.gateOutcome.kind === 'verdict' && args.gateOutcome.verdict.kind === 'failed'
      ? args.gateOutcome.verdict
      : null;
  return commitGateOutcome(args.store, {
    ticketId: args.parkRow.ticketId,
    stageKey: args.stageKey,
    runAt: args.runAt,
    artifactPath,
    gates: [],
    outcome: args.gateOutcome,
    stageRunId: args.stageRunId,
    recoveryTrigger: failedVerdict
      ? {
          sourceProcessId: 'gates',
          sourceStageRunId: args.stageRunId,
          sourceProcessRunId: null,
          triggerKind: 'gate-failure',
          triggerDetail: failedVerdict.reason ?? 'uat gates failed',
          maxRounds: capForGate(
            'uat',
            args.manifest?.uat?.maxFixAttempts,
            args.manifest?.review?.maxFixAttempts,
          ),
        }
      : undefined,
    now: args.now,
    debug: args.debug,
  });
}

/**
 * The gate rows that decided the ticket's CURRENT attempt.
 *
 * Normally those are the parked run's own rows. A re-park is the exception: the
 * re-run opens its own stage run and records NO gate rows (it stands in for the
 * lane only), so the park row it writes names a run whose gate evidence is
 * empty. A second re-run must still aggregate the gates this attempt actually
 * ran — walk back to the newest earlier run that has invocations — or every
 * chain of re-parks would block `nothing-to-run` after the first. The attempt
 * never changes across parks (a park spends no attempt), so this can never
 * borrow another attempt's gates.
 */
function gateRowsForParkedAttempt(
  store: Store,
  ticketId: number,
  stageKey: GateStageKey,
  stageRunId: number | null,
  attempt: number,
): GateRun[] {
  const rows = listGateRuns(store, ticketId).filter(
    (r) => r.stageKey === stageKey && r.attempt === attempt,
  );
  const invocationsOf = (runId: number | null): number =>
    rows.filter(
      (r) => r.stageRunId === runId && !r.skipped && r.repo !== null && r.command !== null,
    ).length;
  const ofRun = (runId: number | null): GateRun[] => rows.filter((r) => r.stageRunId === runId);

  if (invocationsOf(stageRunId) > 0) return ofRun(stageRunId);
  const candidates = [...new Set(rows.map((r) => r.stageRunId))]
    .filter((id): id is number => id !== null && (stageRunId === null || id < stageRunId))
    .sort((a, b) => b - a);
  for (const id of candidates) {
    if (invocationsOf(id) > 0) return ofRun(id);
  }
  return ofRun(stageRunId);
}

/**
 * A sandbox refusal for a re-run (AC-32), mirroring `driveTicket`'s
 * `parkSandboxRefusal` byte for byte in effect: the stage is parked with the
 * driver's own blocker and a bounded reason, and the lane is never run against
 * the host copy. Resume offers the same retry the driver would.
 */
const SANDBOX_REFUSAL_MAX = 600;

function parkSandboxRefusal(
  store: Store,
  ticketId: number,
  stageKey: GateStageKey,
  kind: 'sandbox-sync' | 'sandbox-setup',
  reason: string,
  debug?: (m: string) => void,
): StageRunResult {
  const brief = reason.length > SANDBOX_REFUSAL_MAX ? `${reason.slice(0, SANDBOX_REFUSAL_MAX)}…` : reason;
  debug?.(`[usageLimit] ticket ${ticketId}: ${kind} refused — ${brief}`);
  parkGateStage(store, {
    ticketId,
    stageKey,
    kind,
    reason: brief,
    runAt: nowIso(),
    gates: [],
  });
  return { kind: 'blocked', blocker: kind, reason: brief };
}

export async function rerunParkedStage(opts: RerunParkOptions): Promise<RerunParkResult> {
  const store = opts.store;
  const parkRow = opts.parkRow;
  const now = opts.now ?? nowIso;
  const runAt = now();

  // A caller with no adapter source cannot re-run; fail before resolving the
  // park rather than leaving it claimed with nothing to run.
  if (!opts.adapter && !opts.buildAdapter) {
    throw new Error('usage-limit re-run: no adapter was provided');
  }

  // An OP park (classify, analysis, suggest) names no lane and no target: its
  // re-run is the OP's business — the ticket form's error notification re-runs
  // exactly that op (D159). A stage lane must never stand in for it, so the
  // park is left OPEN for the op path (the claim below would resolve it).
  if (parkRow.kind !== 'stage-block') {
    opts.debug?.(`[usageLimit] park ${parkRow.id} is an op park — the op path owns it`);
    return { kind: 'stopped', alreadyHandled: true };
  }

  const stageKey = (parkRow.stage ?? (parkRow.lane === 'uat' ? 'uat' : 'review')) as GateStageKey;
  if (parkRow.lane !== 'review' && parkRow.lane !== 'uat' && stageKey !== 'review' && stageKey !== 'uat') {
    // BEFORE the claim: a park that names no lane this path can run must stay
    // OPEN. Claiming it first would consume it and run nothing — the park would
    // read as handled while its stage is still blocked on the usage limit.
    opts.debug?.(`[usageLimit] park ${parkRow.id} names no re-runnable lane — left open`);
    return { kind: 'stopped', alreadyHandled: true };
  }

  // 1. Claim the park row atomically before building anything or running. A
  // racing window loses here and returns `stopped` without constructing an
  // adapter, opening a stage run, or touching any state.
  const claim = claimUsageLimitPark(store, parkRow.id, opts.resolution ?? 'rerun', runAt);
  if (!claim.claimed) {
    opts.debug?.(`[usageLimit] park ${parkRow.id} already claimed or invalid`);
    return { kind: 'stopped', alreadyHandled: true };
  }

  // A claim is not a verdict. If this run ends without one (a Stop, an adapter
  // that could not be built, a throw before the lane reports), put the park and
  // its block back, or the user is left with no banner, no control, and no run
  // standing in for the parked lane.
  const restore = (): void => {
    reopenUsageLimitPark(store, parkRow.id, {
      reason: usageLimitReason(opts.provider, opts.model),
      at: now(),
    });
  };

  try {
    // 2. The driver's SANDBOX PREFLIGHT, in the order `driveTicket` runs it:
    // sync the sandbox's work back to the host tree, then verify the sandbox is
    // provisioned. Without it a sandboxed ticket's re-run reads and reviews the
    // HOST worktree — missing every commit the sandbox made since the parked
    // run synced — and asks the verifier about the host copy. A refusal parks
    // the stage with the driver's own blocker; the lane was never run.
    const synced = (await opts.syncSandbox?.(parkRow.ticketId)) ?? { ok: true as const };
    if (!synced.ok) {
      return parkSandboxRefusal(store, parkRow.ticketId, stageKey, 'sandbox-sync', synced.reason, opts.debug);
    }
    const provisioned =
      (await opts.provisionSandbox?.(parkRow.ticketId, opts.signal)) ?? { ok: true as const };
    if (!provisioned.ok) {
      return parkSandboxRefusal(store, parkRow.ticketId, stageKey, 'sandbox-setup', provisioned.reason, opts.debug);
    }

    // 3. Build the adapter ONLY after the claim. The host hands a factory so the
    // override (and its injected resilient/instrumented chain) exists for this
    // one run and never for a loser.
    const adapter = opts.adapter ?? opts.buildAdapter?.(opts.provider, opts.model);
    if (!adapter) {
      throw new Error('usage-limit re-run: no adapter was provided');
    }
    const claimed: ClaimedRerunOptions = {
      ...opts,
      adapter,
      assignment: assignmentFor(opts.resolveAssignment, stageKey, opts.provider, opts.model),
    };

    const result =
      parkRow.lane === 'review' || stageKey === 'review'
        ? await rerunReviewParkedStage(claimed, { stageKey, runAt, now })
        : await rerunUatParkedStage(claimed, { stageKey, runAt, now });
    if (result.kind === 'stopped') restore();
    return result;
  } catch (err) {
    restore();
    throw err;
  }
}

async function rerunReviewParkedStage(
  opts: ClaimedRerunOptions,
  ctx: { stageKey: GateStageKey; runAt: string; now: () => string },
): Promise<StageRunResult> {
  const { store, parkRow, adapter, assignment, manifest, cwd } = opts;
  const keptTargets = parseReviewKeptOutcome(parkRow.keptOutcome).targets;
  const attempt = stageAttempt(store, parkRow.ticketId, 'review');
  return runReview(
    store,
    {
      ticketId: parkRow.ticketId,
      cwd,
      artifactDir: opts.artifactDir,
      manifest,
      signal: opts.signal,
      debug: opts.debug,
      rerun: {
        targets: laneTargetsToAsk(keptTargets, parkRow.target ?? cwd),
        // The parked run's gate rows (or, after a re-park, the run whose gates
        // decided this attempt): inputs to the aggregate, never this run's own.
        previousGateRuns: gateRowsForParkedAttempt(store, parkRow.ticketId, 'review', parkRow.stageRunId, attempt),
        keptTargets,
        priorKeptOutcome: parkRow.keptOutcome,
        process: { assignment, adapter },
      },
    },
    { now: ctx.now, git: opts.git, loadArtifacts: opts.loadArtifacts },
  );
}

async function rerunUatParkedStage(
  opts: ClaimedRerunOptions,
  ctx: { stageKey: GateStageKey; runAt: string; now: () => string },
): Promise<StageRunResult> {
  const { store, parkRow, adapter, assignment, manifest, cwd } = opts;
  const kept = parseUatKeptOutcome(parkRow.keptOutcome);
  const attempt = stageAttempt(store, parkRow.ticketId, 'uat');
  return runUat(
    store,
    {
      ticketId: parkRow.ticketId,
      cwd,
      artifactDir: opts.artifactDir,
      manifest,
      signal: opts.signal,
      debug: opts.debug,
      contextCommand: opts.contextCommand,
      rerun: {
        targets: laneTargetsToAsk(kept.targets, parkRow.target ?? cwd),
        // The parked run's gate rows (or, after a re-park, the run whose gates
        // decided this attempt): inputs to the aggregate, never this run's own.
        previousGateRuns: gateRowsForParkedAttempt(store, parkRow.ticketId, 'uat', parkRow.stageRunId, attempt),
        siblingObservations: kept.observations,
        siblingTargets: kept.targets,
        tester: { assignment, adapter },
      },
    },
    {
      now: ctx.now,
      git: opts.git,
      spin: opts.spin,
      stopServers: opts.stopServers,
      runVerifier: opts.runVerifier,
      detectBaselines: opts.detectBaselines,
    },
  );
}
