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
import type { GitRunner } from '../integrations/git.js';
import type { ReviewArtifacts } from './review/conformance.js';
import { capForGate, type GateStageKey } from './fixAttempts.js';
import { nowIso } from '../model/time.js';
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
import { listUatFindings, type UatFindingInput } from '../store/uatFindings.js';
import { getTicket } from '../store/tickets.js';
import {
  runTesterVerifier,
  TESTER_VERIFIER_FAILURE_PREFIX,
  TESTER_OBSERVATIONS_FAILURE_PREFIX,
  type TesterGateRunner,
} from './uat/testerVerifier.js';
import { laneTargetsToAsk, type KeptTarget } from './usageLimitKept.js';

/** A sibling target's status carried on a UAT park row's `keptOutcome`. */
interface UatKeptTarget extends KeptTarget {
  observations?: number;
}

/** A sibling target's status carried on a Review park row's `keptOutcome`. */
interface ReviewKeptTarget extends KeptTarget {
  findings?: number;
}

/**
 * The sibling targets AND the observations a UAT park row kept: the evidence
 * the stopped Tester had already produced. Both must survive a re-park — the
 * observations to count (they are already durable from the run that made
 * them), the target statuses to carry forward on the next park row.
 */
function parseUatKeptOutcome(raw: string | null): {
  observations: UatFindingInput[];
  targets: UatKeptTarget[];
} {
  const observations: UatFindingInput[] = [];
  const targets: UatKeptTarget[] = [];
  try {
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.observations)) {
        for (const obs of parsed.observations) {
          if (obs && typeof obs === 'object' && typeof obs.severity === 'string' && typeof obs.title === 'string') {
            observations.push({
              severity: obs.severity,
              title: obs.title,
              repo: obs.repo ?? null,
              file: obs.file ?? null,
              line: obs.line ?? null,
            });
          }
        }
      }
      if (Array.isArray(parsed.targets)) {
        for (const t of parsed.targets) {
          if (t && typeof t === 'object' && typeof t.repo === 'string') {
            targets.push(t as UatKeptTarget);
          }
        }
      }
    }
  } catch {
    // A malformed kept outcome keeps nothing — never a crash.
  }
  return { observations, targets };
}

function parseReviewKeptOutcome(raw: string | null): {
  findings: number;
  targets: ReviewKeptTarget[];
} {
  try {
    const parsed = raw ? JSON.parse(raw) : null;
    return {
      findings: typeof parsed?.findings === 'number' ? parsed.findings : 0,
      targets: Array.isArray(parsed?.targets)
        ? parsed.targets.filter(
            (t: unknown): t is ReviewKeptTarget =>
              !!t && typeof t === 'object' && typeof (t as { repo?: unknown }).repo === 'string',
          )
        : [],
    };
  } catch {
    return { findings: 0, targets: [] };
  }
}

/**
 * Carry the earlier park's sibling TARGETS forward when a review re-run parks
 * again. The fresh lane names only the target it touched; without this merge a
 * second quota stop would forget a partner target's `unreadable`/`ok` status,
 * which the next re-run's R6b ratio depends on. Findings themselves are already
 * durable in `review_findings`; this is the status/count half.
 */
function mergeReviewKeptOutcome(fresh: string, prior: string | null): string {
  const freshParsed = parseReviewKeptOutcome(fresh);
  const priorParsed = parseReviewKeptOutcome(prior);
  const freshRepos = new Set(freshParsed.targets.map((t) => t.repo));
  const preserved = priorParsed.targets.filter((t) => !freshRepos.has(t.repo));
  const preservedFindings = preserved.reduce(
    (n, t) => n + (typeof t.findings === 'number' ? t.findings : 0),
    0,
  );
  return JSON.stringify({
    findings: preservedFindings + freshParsed.findings,
    targets: [...preserved, ...freshParsed.targets],
  });
}

/**
 * Merge a re-run's fresh UAT outcome with the siblings the earlier park kept.
 *
 * `testerResult.keptOutcome` names only the target THIS run touched; a re-run
 * that parks AGAIN would otherwise drop everything a partner target answered
 * before the first park — the very evidence the one-shot merge exists to
 * protect, lost on the second quota stop. Sibling observations lead (they were
 * observed first), and the fresh target statuses win for the re-run target (a
 * re-parked target must read `usage-limited`, not its stale prior status).
 */
function mergeUatKeptOutcome(
  fresh: string,
  siblingObservations: readonly UatFindingInput[],
  siblingTargets: readonly UatKeptTarget[],
): string {
  let freshObservations: unknown[] = [];
  let freshTargets: unknown[] = [];
  try {
    const parsed = JSON.parse(fresh);
    if (Array.isArray(parsed.observations)) freshObservations = parsed.observations;
    if (Array.isArray(parsed.targets)) freshTargets = parsed.targets;
  } catch {
    // A malformed fresh outcome degrades to the siblings alone, never drops them.
  }
  const freshRepos = new Set(
    freshTargets
      .map((t) => (t && typeof t === 'object' ? (t as { repo?: unknown }).repo : undefined))
      .filter((r): r is string => typeof r === 'string'),
  );
  const preservedTargets = siblingTargets.filter((t) => !freshRepos.has(t.repo));
  return JSON.stringify({
    observations: [...siblingObservations, ...freshObservations],
    targets: [...preservedTargets, ...freshTargets],
  });
}

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

/** A target's tree, as the parked run recorded it (or the primary `cwd`). */
interface TargetTree {
  path: string;
  baseRef: string | null;
  branch: string | null;
}

/**
 * Resolve one asked repository to the tree it must be reviewed/tested in.
 *
 * A target with NO registered worktree row must never fall back to `cwd`: that
 * reviews or tests the primary checkout under another repository's name. The
 * only legitimate `cwd` substitution is the no-manifest path, where the stage
 * itself asked exactly `cwd` (so the repo it recorded IS that path). Anything
 * else is unresolvable and the caller parks instead of asking the wrong tree.
 */
function targetTree(
  worktrees: readonly WorktreeView[],
  repo: string,
  cwd: string,
): TargetTree | null {
  const wt = worktrees.find((w) => w.repo === repo);
  if (wt) return { path: wt.path, baseRef: wt.baseRef, branch: wt.branch };
  return repo === cwd ? { path: cwd, baseRef: null, branch: null } : null;
}

/** The repos this run cannot ask, because the ticket has no worktree row for them. */
function unresolvedTargets(
  worktrees: readonly WorktreeView[],
  repos: readonly string[],
  cwd: string,
): string[] {
  return repos.filter((repo) => targetTree(worktrees, repo, cwd) === null);
}

/**
 * Park the stage because one of the targets has no registered worktree.
 *
 * Committed as a BLOCK through the shared outcome writer, never run against a
 * guessed tree: the one-shot was spent and the stage is left with an actionable,
 * resumable reason (`nothing-to-run`) instead of a review/UAT of the wrong
 * checkout wearing the target's name.
 */
function commitUnresolvedTargets(args: {
  store: Store;
  ticketId: number;
  stageKey: GateStageKey;
  runAt: string;
  artifactDir: string;
  stageRunId: number;
  lane: 'review' | 'uat';
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
    outcome: { kind: 'blocked', blocker: 'nothing-to-run', reason: args.reason },
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
 * A parked run's rows as aggregate entries — actual gate invocations only.
 *
 * A stage run also records NON-gate evidence under the same `stage_run_id`: the
 * `changes` row (Changes panel opened) carries `exitCode: 0` but no invocation
 * identity, and a skipped row names a gate the user disabled. Feeding either to
 * the aggregate would count a question nobody asked as a gate that RAN (R3) and
 * as an identity UAT never asked (R7), letting a re-run pass a stage that asked
 * nothing. A real invocation is exactly a non-skipped row that recorded its
 * `{repo, command}` (v21 identity).
 */
function gateEntriesFrom(runs: readonly GateRun[]): AggregateEntry[] {
  return runs
    .filter((r) => !r.skipped && r.repo !== null && r.command !== null)
    .map((r) => ({
      result: {
        name: r.gateName,
        exitCode: r.exitCode,
        output: r.summary ?? '',
        startedAt: r.startedAt ?? undefined,
        endedAt: r.endedAt ?? undefined,
      },
      identity: {
        name: r.gateName,
        repo: r.repo ?? '',
        command: r.command ?? r.gateName,
        args: r.args ?? [],
      },
    }));
}

/**
 * Every manifest entry backed by this worktree path. The UAT stage derives the
 * same list while planning; the re-run has a store row's repoPath, so it maps
 * back to the names `unitsOf` needs to find the target's running services.
 */
function manifestNamesFor(manifest: Manifest | undefined, repoPath: string): string[] {
  if (!manifest?.repositories) return [];
  return Object.entries(manifest.repositories)
    .filter(([, def]) => def.repoPath === repoPath)
    .map(([name]) => name);
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
  const {
    store,
    parkRow,
    adapter,
    assignment,
    manifest,
    cwd,
    artifactDir,
    signal,
    debug,
  } = opts;
  const { stageKey, runAt, now } = ctx;

  // Opened with the SHARED gate-run handle, never the bare `openStageRun`:
  // `openGateRun` attaches a run opened while a recovery round awaits its
  // revalidation to that round, so a passing re-run completes the round it
  // stands in for (`commitGateOutcome`'s passed path completes the round whose
  // run id this is). The bare opener skips the attachment and would leave the
  // round 'revalidating' forever.
  const evidence = openGateRun(store, {
    ticketId: parkRow.ticketId,
    stageKey,
    runAt,
    manifest,
    pid: process.pid,
    debug,
  });
  const newStageRunId = evidence.runId;
  const attempt = evidence.attempt;

  const targetRepo = parkRow.target ?? cwd;
  const worktrees = listWorktreesByTicket(store, parkRow.ticketId);
  const keptTargets = parseReviewKeptOutcome(parkRow.keptOutcome).targets;
  const askedRepos = laneTargetsToAsk(keptTargets, targetRepo);

  // Never substitute `cwd` for a target the ticket has no worktree row for:
  // that reviews another repository's checkout under this target's name.
  const unresolved = unresolvedTargets(worktrees, askedRepos, cwd);
  if (unresolved.length > 0) {
    const reason =
      `${unresolved.join(', ')}: no worktree is registered for this ticket, ` +
      'so there is no tree to review — re-scope the ticket';
    debug?.(`[gate] review ticket ${parkRow.ticketId}: ${reason}`);
    return commitUnresolvedTargets({
      store,
      ticketId: parkRow.ticketId,
      stageKey,
      runAt,
      artifactDir,
      stageRunId: newStageRunId,
      lane: 'review',
      reason,
      now,
      debug,
    });
  }

  const laneTargets: FindingsLaneTarget[] = askedRepos.map((repo) => {
    const tree = targetTree(worktrees, repo, cwd)!;
    return {
      repo,
      worktreePath: tree.path,
      baseRef: tree.baseRef,
      branch: tree.branch,
    };
  });

  const config = {
    ...DEFAULT_REVIEW_FINDINGS,
    ...(manifest?.review?.findings ?? {}),
  };
  const overrideProcess: FindingsProcessInput = {
    // The role's resolved snapshot, not a provider/model stub: the profile body
    // is the review prompt and the effort/agent name are the run's identity.
    assignment,
    adapter,
    stageRunId: newStageRunId,
    attempt,
    pid: process.pid,
    startedAt: runAt,
  };

  // Read the SIBLING findings BEFORE the lane runs: the lane now persists its
  // own findings as they land (`persistFindings`), so reading afterwards would
  // count the re-run's own findings as siblings and double them.
  const existingFindings = findingsForAttempt(store, parkRow.ticketId, attempt);

  // The conformance artifacts the reviewer judges the change against — loaded
  // by the caller (the read touches the store) and never allowed to fail the
  // stage: a rejection logs and the lane runs without them, exactly like the
  // stage.
  let artifacts: ReviewArtifacts | undefined;
  if (opts.loadArtifacts) {
    try {
      const loaded = await opts.loadArtifacts();
      artifacts = loaded ? { ...loaded, targets: askedRepos } : undefined;
    } catch (err) {
      debug?.(`[gate] review ticket ${parkRow.ticketId}: artifacts unavailable (${String(err)})`);
    }
  }

  const laneOutcome = await runFindingsLane({
    config,
    adapter,
    targets: laneTargets,
    ticketId: parkRow.ticketId,
    signal,
    store,
    process: overrideProcess,
    // A parked review is re-reviewed against the SAME evidence shape the stage
    // uses: a worktree SNAPSHOT (committed and uncommitted as one tree), not the
    // committed-only branch range. Without the snapshot a ticket whose work is
    // uncommitted — the normal case before ship — would re-review as empty and
    // pass. `openChanges` only selects the fallback wording when no snapshot
    // could be made.
    git: opts.git,
    artifacts,
    openChanges: opts.openChanges ?? manifest?.review?.openChanges,
    // Findings land the instant the lane produces them, attributed to this
    // re-run's Review process run — the same durability the stage gets.
    persistFindings: (findings, processRunId) => evidence.appendFindings(findings, processRunId),
    debug,
  });

  if (laneOutcome.kind === 'stopped') {
    if (laneOutcome.processRunId) {
      finishProcessRun(store, laneOutcome.processRunId, 'interrupted', now(), 'interrupted');
    }
    // The run this re-run OPENED must be closed even on a Stop: nothing else
    // ever will (the process stays alive, so the activation sweep never marks
    // it stale), and a `running` row no process will finish is a lie the
    // dashboard renders as a live stage.
    closeStageRun(store, newStageRunId, 'stopped', now());
    return { kind: 'stopped' };
  }

  // The complete target set, not just this run's: the siblings that already
  // answered and the ones this re-run just finished. `askedRepos` is a subset,
  // so the count must union both rather than add one to a sibling count.
  const askedSet = new Set(askedRepos);
  const totalTargetCount = new Set([
    ...keptTargets.map((t) => t.repo),
    ...askedRepos,
  ]).size;
  const siblingUnreadable = keptTargets
    .filter((t) => !askedSet.has(t.repo) && t.status === 'unreadable')
    .map((t) => t.repo);

  // Current newly found findings (the siblings were read before the lane ran)
  const newFindings = laneOutcome.kind === 'ran' ? laneOutcome.findings : [];
  const mergedFindings: FindingInput[] = [
    ...existingFindings.map((f) => ({
      severity: f.severity,
      repo: f.repo,
      file: f.file,
      line: f.line,
      title: f.title,
      detail: f.detail,
      source: f.source,
    })),
    ...newFindings,
  ];

  const mergedUnreadable = [
    ...(laneOutcome.kind === 'ran' ? (laneOutcome.unreadable ?? []) : []),
    ...siblingUnreadable,
  ];

  const effectiveLaneOutcome: FindingsLaneOutcome =
    laneOutcome.kind === 'ran'
      ? {
          kind: 'ran',
          findings: mergedFindings,
          crashes: laneOutcome.crashes,
          unreadable: mergedUnreadable.length > 0 ? mergedUnreadable : undefined,
          targetCount: totalTargetCount,
          processRunId: laneOutcome.processRunId,
        }
      : laneOutcome.kind === 'usage-limited'
        ? {
            ...laneOutcome,
            // A second quota stop must still name the siblings the earlier park
            // kept, exactly like the UAT merge.
            keptOutcome: mergeReviewKeptOutcome(laneOutcome.keptOutcome, parkRow.keptOutcome),
          }
        : laneOutcome;

  // The deterministic gates this review stands in for ran in the PARKED run
  // (or, after a re-park, in the run whose gates decided this attempt). Only
  // its actual gate invocations are inputs to the aggregate: the run's
  // non-gate evidence (the `changes` row, skipped rows) asked nothing and must
  // not let R3/R7 read the re-run as having asked a question.
  const previousGateRuns = gateRowsForParkedAttempt(
    store,
    parkRow.ticketId,
    'review',
    parkRow.stageRunId,
    attempt,
  );
  const entries: AggregateEntry[] = gateEntriesFrom(previousGateRuns);

  const uatIdentities = uatIdentitiesFrom(listGateRuns(store, parkRow.ticketId));
  const blockingSeverity = config.blockingSeverity;

  const aggregateOutcome = aggregateReview(entries, uatIdentities, effectiveLaneOutcome, {
    // The DEFAULT, never `false`: a manifest that omits the key must not
    // silently bypass R7 on the re-run while the stage path fails the same run.
    requireIndependentSignal:
      manifest?.review?.requireIndependentSignal ?? DEFAULT_REQUIRE_INDEPENDENT_SIGNAL,
    findingsBlockingSeverity: blockingSeverity,
    disabledGateNames: [],
  });

  // Close the Review process run on EVERY non-stopped path, INCLUDING a
  // re-park: a usage-limited lane still opened a run, and discarding its id here
  // would leave a `running` row with no result kind forever.
  const processRunId =
    laneOutcome.kind === 'ran' || laneOutcome.kind === 'usage-limited'
      ? (laneOutcome.processRunId ?? null)
      : null;
  if (processRunId !== null) {
    const blocking =
      aggregateOutcome.kind === 'verdict' &&
      aggregateOutcome.verdict.kind === 'failed' &&
      (aggregateOutcome.verdict.reason ?? '').startsWith(FINDINGS_FAILURE_PREFIX);
    const crashes = laneOutcome.kind === 'ran' ? laneOutcome.crashes : undefined;
    const unreadableTargets = laneOutcome.kind === 'ran' ? (laneOutcome.unreadable ?? []) : [];
    const isUnreadable = unreadableTargets.length > 0;
    const unreadableBlock =
      isUnreadable &&
      aggregateOutcome.kind === 'blocked' &&
      aggregateOutcome.blocker === 'capability-missing';
    const usageLimited = laneOutcome.kind === 'usage-limited';

    if (artifactDir) {
      mkdirSync(artifactDir, { recursive: true });
    }
    const logPath = artifactDir ? join(artifactDir, `review-ticket-${parkRow.ticketId}-${newStageRunId}.log`) : '';

    if ((crashes?.length ?? 0) > 0 || unreadableBlock || usageLimited) {
      const uniqueCrashes = [...new Set(crashes ?? [])];
      const failureDetail =
        usageLimited && laneOutcome.kind === 'usage-limited'
          ? laneOutcome.detail
          : uniqueCrashes.length > 0
            ? collapseDiagnostic(uniqueCrashes.join('; '))
            : null;
      finishProcessRun(
        store,
        processRunId,
        'failed',
        now(),
        'execution-failed',
        logPath,
        failureDetail,
      );
    } else if (blocking) {
      finishProcessRun(store, processRunId, 'failed', now(), 'blocking', logPath);
    } else {
      finishProcessRun(store, processRunId, 'passed', now(), 'validated', logPath);
    }
  }

  if (artifactDir) {
    mkdirSync(artifactDir, { recursive: true });
  }
  const artifactPath = artifactDir ? join(artifactDir, `review-ticket-${parkRow.ticketId}-${newStageRunId}.log`) : '';
  const artifactLines = [
    `! re-run parked review: target(s) ${askedRepos.join(', ')} with ${assignment.provider}/${assignment.model ?? 'default'}`,
  ];
  if (aggregateOutcome.kind === 'blocked') {
    artifactLines.push(`! ${aggregateOutcome.reason}`);
    debug?.(`[gate] review ticket ${parkRow.ticketId}: blocked (${aggregateOutcome.blocker}: ${aggregateOutcome.reason})`);
  }
  if (laneOutcome.kind === 'ran') {
    for (const crash of laneOutcome.crashes ?? []) {
      artifactLines.push(`! review findings lane failed: ${crash}`);
    }
    for (const u of laneOutcome.unreadable ?? []) {
      artifactLines.push(`! review findings lane unreadable output: ${u}`);
    }
  }
  if (artifactPath) {
    writeFileSync(artifactPath, artifactLines.join('\n') + '\n');
  }

  let recoveryTrigger: RecoveryTriggerInput | undefined;
  if (aggregateOutcome.kind === 'verdict' && aggregateOutcome.verdict.kind === 'failed') {
    const reason = aggregateOutcome.verdict.reason ?? 'review findings failed';
    // Mirror `stages/review.ts`'s `recoveryTriggerFor`: the causal source is
    // read off the failure constant, never assumed. A reason that does NOT start
    // with `FINDINGS_FAILURE_PREFIX` is a deterministic gate failure (the
    // reachable one here is R7's "review asked no question uat does not …"),
    // attributed to `gates` with NO AI process — attributing it to `review`/the
    // findings process run would misreport the cause to the Inside recovery
    // prose and to the `byTriggerKind` quality metrics.
    const fromFindings = reason.startsWith(FINDINGS_FAILURE_PREFIX);
    const maxRounds = capForGate('review', manifest?.uat?.maxFixAttempts, manifest?.review?.maxFixAttempts);
    recoveryTrigger = {
      sourceProcessId: fromFindings ? 'review' : 'gates',
      sourceStageRunId: newStageRunId,
      sourceProcessRunId: fromFindings ? processRunId : null,
      triggerKind: fromFindings ? 'blocking-review-findings' : 'gate-failure',
      triggerDetail: reason,
      maxRounds,
    };
  }

  return commitGateOutcome(store, {
    ticketId: parkRow.ticketId,
    stageKey,
    runAt,
    artifactPath,
    // The parked run's deterministic gate rows are INPUTS to this aggregate,
    // never this run's own evidence: this re-run executes the AI lane only. The
    // rows stay attached to the stage run that actually produced them; copying
    // them onto this run would claim gate work nobody did here.
    gates: [],
    outcome: aggregateOutcome,
    // Findings are NOT passed here: the lane already persisted each one as it
    // landed (`persistFindings`), so handing them over again would duplicate the
    // batch in `review_findings`.
    stageRunId: newStageRunId,
    recoveryTrigger,
    now,
    debug,
  });
}

async function rerunUatParkedStage(
  opts: ClaimedRerunOptions,
  ctx: { stageKey: GateStageKey; runAt: string; now: () => string },
): Promise<StageRunResult> {
  const {
    store,
    parkRow,
    adapter,
    assignment,
    manifest,
    cwd,
    artifactDir,
    signal,
    git,
    debug,
  } = opts;
  const { stageKey, runAt, now } = ctx;

  // The shared gate-run handle (see the review re-run): a run opened while a
  // recovery round awaits its revalidation IS that revalidation.
  const evidence = openGateRun(store, {
    ticketId: parkRow.ticketId,
    stageKey,
    runAt,
    manifest,
    pid: process.pid,
    debug,
  });
  const newStageRunId = evidence.runId;
  const attempt = evidence.attempt;

  // The deterministic gates this UAT stands in for ran in the PARKED run, and
  // they must decide exactly as they would have there. `aggregateUat` is the
  // ONLY producer of `bypassed` (every gate deliberately disabled) and of the
  // zero-ran block, and a hard-coded `passed` would record a gate outcome
  // nobody proved — the very bug R3 exists to close. Skipped rows are evidence
  // that a gate was switched off, never an invocation; they only name why a
  // zero-ran run is bypassed rather than blocked.
  const parkedGateRuns = gateRowsForParkedAttempt(
    store,
    parkRow.ticketId,
    'uat',
    parkRow.stageRunId,
    attempt,
  );
  const gateOutcome: AggregateOutcome = aggregateUat(
    gateEntriesFrom(parkedGateRuns),
    reviewIdentitiesFrom(listGateRuns(store, parkRow.ticketId)),
    parkedGateRuns.filter((r) => r.skipped).map((r) => r.gateName),
  );
  if (gateOutcome.kind === 'blocked' || gateOutcome.verdict.kind === 'failed') {
    // The stage never runs its Tester on a gate that blocked or failed, so the
    // re-run must not either: commit the gates' own outcome (a block spends no
    // attempt; a failure opens the gate's recovery round).
    return commitParkedGateOutcome({
      store,
      parkRow,
      stageKey,
      runAt,
      artifactDir,
      stageRunId: newStageRunId,
      manifest,
      gateOutcome,
      now,
      debug,
    });
  }
  // Narrowed once, here: the verdict this re-run may commit when the Tester and
  // the verifier add nothing (passed, or bypassed when every gate was disabled).
  const gateVerdict = gateOutcome.verdict;

  const targetRepo = parkRow.target ?? cwd;
  const worktrees = listWorktreesByTicket(store, parkRow.ticketId);

  // The sibling targets AND the observations the earlier park kept. Both must
  // survive a re-park: the observations to count (they are already durable from
  // the run that made them), the target statuses to carry forward on the next
  // park row — and the `not-run` ones to ASK, so a re-run finishes the lane's
  // work instead of committing a verdict that silently omits them.
  const { observations: siblingObservations, targets: siblingTargets } = parseUatKeptOutcome(
    parkRow.keptOutcome,
  );

  // The targets this re-run must ask: the parked one plus every target the
  // original Tester never reached (recorded `not-run` on the park row).
  const askedRepos = laneTargetsToAsk(siblingTargets, targetRepo);

  // Never test another repository's checkout under this target's name: a target
  // with no worktree row parks instead of falling back to `cwd`.
  const unresolved = unresolvedTargets(worktrees, askedRepos, cwd);
  if (unresolved.length > 0) {
    const reason =
      `${unresolved.join(', ')}: no worktree is registered for this ticket, ` +
      'so there is no tree to test — re-scope the ticket';
    debug?.(`[gate] uat ticket ${parkRow.ticketId}: ${reason}`);
    return commitUnresolvedTargets({
      store,
      ticketId: parkRow.ticketId,
      stageKey,
      runAt,
      artifactDir,
      stageRunId: newStageRunId,
      lane: 'uat',
      reason,
      now,
      debug,
    });
  }

  // The Tester is asked about the SAME ticket the stage asks about: its
  // done-when criteria (`description`), its canonical intent and key. Without
  // them the re-run would judge a different, weaker question than the run it
  // replaces — and a passing re-run could advance on a generic "does it work".
  const ticket = getTicket(store, parkRow.ticketId);

  // ---- Plan the ticket's services exactly like the UAT stage (D155) ----
  // A browser re-run must exercise a LIVE app, so the services the stage would
  // have started are started here too. A stack the user already runs is theirs:
  // karst neither spins nor stops it. Anything less than the whole stack is the
  // re-run's (spinTicket stops every ticket server first), so it is stopped
  // again on every exit path — including a partial spin failure.
  const spinFn = opts.spin;
  const stopFn = opts.stopServers;
  const spinManifest = manifest;
  let ownsStack = false;
  let spinHot: string[] = [];
  if (spinFn && stopFn && spinManifest !== undefined) {
    const hot = runnableSubset(spinManifest, ticket.selectedRepos);
    if (hot.length > 0) {
      const running = new Set(
        listServersByTicket(store, parkRow.ticketId)
          .filter((s) => s.status === 'running')
          .map((s) => s.service),
      );
      const needed = unitsOfRepos(spinManifest, hot).map((u) => u.key);
      if (needed.length > 0 && needed.every((key) => running.has(key))) {
        debug?.(
          `[gate] uat ticket ${parkRow.ticketId}: ${needed.length} service(s) already running — ` +
            `reusing the user's stack, no spin and no stop`,
        );
      } else {
        ownsStack = true;
        spinHot = hot;
      }
    }
  }

  /** The Tester half, run AFTER the services are up and closed by `finally`. */
  const runTesterAndCommit = async (): Promise<StageRunResult> => {
    // Built AFTER the spin so the prompt names the services THIS run started —
    // through the SAME mapper the stage uses (`testerTargets`): base branch,
    // ticket branch and each target's running services.
    const targets = testerTargets(
      manifest,
      askedRepos.map((repo) => ({
        repo,
        path: targetTree(worktrees, repo, cwd)!.path,
        names: manifestNamesFor(manifest, repo),
      })),
      worktrees,
      listServersByTicket(store, parkRow.ticketId),
    );

    const blockingSeverity = manifest?.uat?.testerObservations?.blockingSeverity ?? 'none';
    const testerResult = await runUatTester(
      store,
      {
        ticketId: parkRow.ticketId,
        targets,
        // The role-resolved snapshot (profile instructions, effort, agent name),
        // with the one-shot pick on top — never a provider/model stub.
        assignment,
        adapter,
        stageRunId: newStageRunId,
        attempt,
        signal,
        // Snapshot the worktree exactly like the stage's Tester: committed AND
        // uncommitted work as one tree, never a committed-only branch range.
        git,
        criteria: ticket.description,
        intent: ticket.intent,
        ticketKey: ticket.key,
        contextCommand: opts.contextCommand,
        debug,
        observationsBlockingSeverity: blockingSeverity,
        tokenBudget: manifest?.uat?.tester?.tokenBudget,
      },
      { now },
    );

    if (testerResult.kind === 'interrupted') {
      // Close the run this re-run opened (see the review stopped path).
      closeStageRun(store, newStageRunId, 'stopped', now());
      return { kind: 'stopped' };
    }

    // Find the opened tester process run id
    let testerRunId: number | null = null;
    for (const run of listProcessRuns(store, parkRow.ticketId).reverse()) {
      if (run.processId === 'tester' && run.stageRunId === newStageRunId) {
        testerRunId = run.id;
        break;
      }
    }

    // The host may pass an empty artifactDir (no artifact directory configured);
    // `mkdirSync('')` throws ENOENT, so guard it exactly like the review path.
    const artifactPath = artifactDir
      ? join(artifactDir, `uat-ticket-${parkRow.ticketId}-${newStageRunId}.log`)
      : '';
    if (artifactPath) {
      mkdirSync(artifactDir, { recursive: true });
      writeFileSync(
        artifactPath,
        `! re-run parked uat: target(s) ${askedRepos.join(', ')} with ${assignment.provider}/${assignment.model ?? 'default'}\n`,
      );
    }

    // Calculate the blocking count across newly observed findings and the sibling
    // observations the earlier park kept. The siblings are NOT re-inserted into
    // `uat_findings`: they were recorded by the run that made them and still read
    // back from the store, so writing them again under this run's process would
    // duplicate every row across runs. They are only counted here — the verdict
    // must not discard a blocking observation a partner target already reported.
    let combinedBlocking = 0;
    let combinedSummary: string | undefined;
    {
      const newlyObservedFindings =
        testerResult.kind === 'observed' || testerResult.kind === 'partial'
          ? listUatFindings(store, parkRow.ticketId)
              .filter((f) => testerRunId !== null && f.processRunId === testerRunId)
              .map((f) => ({
                severity: f.severity,
                repo: f.repo,
                file: f.filePath,
                line: f.line,
                title: f.title,
              }))
          : [];
      const counted = countBlockingObservations(
        [...newlyObservedFindings, ...siblingObservations],
        blockingSeverity,
      );
      combinedBlocking = counted.blocking;
      combinedSummary = counted.blockingSummary;
    }

    if (testerResult.kind === 'unreadable-output') {
      const reason = 'uat tester: every target answered unreadable output — nothing could be read out of it';
      return commitGateOutcome(store, {
        ticketId: parkRow.ticketId,
        stageKey,
        runAt,
        artifactPath,
        gates: [],
        outcome: {
          kind: 'blocked',
          blocker: 'capability-missing',
          reason,
        },
        stageRunId: newStageRunId,
        now,
        debug,
      });
    }

    if (testerResult.kind === 'usage-limited') {
      return commitGateOutcome(store, {
        ticketId: parkRow.ticketId,
        stageKey,
        runAt,
        artifactPath,
        gates: [],
        outcome: {
          kind: 'blocked',
          blocker: 'usage-limit',
          reason: testerResult.detail,
          park: {
            provider: testerResult.provider,
            model: testerResult.model,
            lane: 'uat',
            target: testerResult.target,
            detail: testerResult.detail,
            keptOutcome: mergeUatKeptOutcome(
              testerResult.keptOutcome,
              siblingObservations,
              siblingTargets,
            ),
          },
        },
        stageRunId: newStageRunId,
        now,
        debug,
      });
    }

    // The optional deterministic verifier: the stage runs it AFTER the Tester and
    // BEFORE deciding, so a re-run that skipped it would commit a PASSED UAT with
    // the exit-code boundary never executed — the "a verdict comes from an exit
    // code, never an agent's self-report" invariant bypassed. Absent with no
    // verifier configured → nothing runs, and the observations are governed by the
    // threshold below alone.
    const verifierGate = manifest?.uat?.testerVerifier;
    if (verifierGate !== undefined) {
      const verification = await runTesterVerifier(
        {
          gate: verifierGate,
          // The stage runs the ticket-level verifier in its FIRST target's
          // worktree; the re-run's first asked target is the parked one.
          cwd: targets[0]?.worktreePath ?? cwd,
          signal,
          onDebug: debug,
        },
        { run: opts.runVerifier },
      );
      switch (verification.kind) {
        case 'passed':
        case 'absent':
          break;
        case 'failed': {
          // A completed nonzero exit is a DETERMINISTIC validation failure: the
          // Tester's observation is disproven and the failed verdict opens a
          // recovery round naming the Tester process.
          if (testerRunId !== null) {
            setProcessRunResultKind(store, testerRunId, 'verification-failed');
          }
          const reason = `${TESTER_VERIFIER_FAILURE_PREFIX}exit code ${verification.exitCode}`;
          const maxRounds = capForGate('uat', manifest?.uat?.maxFixAttempts, manifest?.review?.maxFixAttempts);
          return commitGateOutcome(store, {
            ticketId: parkRow.ticketId,
            stageKey,
            runAt,
            artifactPath,
            gates: [],
            outcome: { kind: 'verdict', verdict: { kind: 'failed', reason } },
            stageRunId: newStageRunId,
            recoveryTrigger: {
              sourceProcessId: 'tester',
              sourceStageRunId: newStageRunId,
              sourceProcessRunId: testerRunId,
              triggerKind: 'tester-verifier-failure',
              triggerDetail: reason,
              maxRounds,
            },
            now,
            debug,
          });
        }
        case 'execution-failed': {
          // A command that could not run is environmental: park, never a verdict
          // — no attempt is consumed and no recovery round opens.
          const reason =
            `uat tester verifier "${verifierGate.name}" could not run: ${verification.message}`;
          return commitGateOutcome(store, {
            ticketId: parkRow.ticketId,
            stageKey,
            runAt,
            artifactPath,
            gates: [],
            outcome: { kind: 'blocked', blocker: 'capability-missing', reason },
            stageRunId: newStageRunId,
            now,
            debug,
          });
        }
        case 'interrupted':
          closeStageRun(store, newStageRunId, 'stopped', now());
          return { kind: 'stopped' };
      }
    }

    // The opt-in observation threshold, AFTER the verifier so the deterministic
    // boundary keeps precedence — exactly the stage's order. `combinedBlocking`
    // counts BOTH the observations the tester just recorded and the sibling
    // observations the earlier park kept, whether or not this call executed. A
    // failed re-run must never discard a blocking observation a partner target
    // already reported and call the stage clean.
    if (combinedBlocking > 0) {
      const reason = `${TESTER_OBSERVATIONS_FAILURE_PREFIX}${combinedSummary ?? `${combinedBlocking} blocking`}`;
      const maxRounds = capForGate('uat', manifest?.uat?.maxFixAttempts, manifest?.review?.maxFixAttempts);
      return commitGateOutcome(store, {
        ticketId: parkRow.ticketId,
        stageKey,
        runAt,
        artifactPath,
        gates: [],
        outcome: { kind: 'verdict', verdict: { kind: 'failed', reason } },
        stageRunId: newStageRunId,
        recoveryTrigger: {
          sourceProcessId: 'tester',
          sourceStageRunId: newStageRunId,
          sourceProcessRunId: testerRunId,
          triggerKind: 'blocking-tester-observations',
          triggerDetail: reason,
          maxRounds,
        },
        now,
        debug,
      });
    }

    // Gates passed (or were all deliberately disabled by the user: BYPASSED,
    // never `passed` — no outcome was proven), the Tester had no blocking
    // observations, and the verifier (when configured) passed. The verdict is
    // the parked run's own gate verdict, exactly as the stage would commit it.
    return commitGateOutcome(store, {
      ticketId: parkRow.ticketId,
      stageKey,
      runAt,
      artifactPath,
      gates: [],
      outcome: { kind: 'verdict', verdict: gateVerdict },
      stageRunId: newStageRunId,
      now,
      debug,
    });
  };

  try {
    // The spin is INSIDE the try so the `finally` covers a partial failure too:
    // `spinTicket` leaves the services it already started running when a later
    // one fails, and a `boot-failed` park must still stop whatever came up.
    if (ownsStack && spinFn && spinManifest !== undefined) {
      debug?.(
        `[gate] uat ticket ${parkRow.ticketId}: spinning ${spinHot.length} runnable repo(s) before the Tester`,
      );
      try {
        await spinFn(store, spinManifest, parkRow.ticketId, spinHot, {
          signal,
          debug,
        });
      } catch (error) {
        // A Stop is a cancel, never an environment fault.
        if (error instanceof SpinCancelledError) {
          debug?.(`[gate] uat ticket ${parkRow.ticketId}: spin cancelled — stopped`);
          closeStageRun(store, newStageRunId, 'stopped', now());
          return { kind: 'stopped' };
        }
        // An environment fault is a BLOCK, never a failed verdict: the code was
        // not judged, so no fix round may be spent on it.
        const reason =
          `could not start the ticket's services: ` +
          (error instanceof Error ? error.message : String(error));
        debug?.(`[gate] uat ticket ${parkRow.ticketId}: spin failed — parked boot-failed`);
        const bootPath = artifactDir
          ? join(artifactDir, `uat-ticket-${parkRow.ticketId}-${newStageRunId}.log`)
          : '';
        if (bootPath) {
          mkdirSync(artifactDir, { recursive: true });
          writeFileSync(bootPath, `! ${reason}\n`);
        }
        return commitGateOutcome(store, {
          ticketId: parkRow.ticketId,
          stageKey,
          runAt,
          artifactPath: bootPath,
          gates: [],
          outcome: { kind: 'blocked', blocker: 'boot-failed', reason },
          stageRunId: newStageRunId,
          now,
          debug,
        });
      }
    }
    return await runTesterAndCommit();
  } finally {
    // Stop the services THIS re-run started on every exit path. A stack the
    // user owns is untouched. Best-effort: a stop that cannot run must never
    // replace the stage's own outcome.
    if (ownsStack && stopFn) {
      try {
        await stopFn(store, parkRow.ticketId);
        debug?.(`[gate] uat ticket ${parkRow.ticketId}: stopped the ticket's services after the re-run`);
      } catch (error) {
        debug?.(
          `[gate] uat ticket ${parkRow.ticketId}: stopping the ticket's services failed: ` +
            (error instanceof Error ? error.message : String(error)),
        );
      }
    }
  }
}

