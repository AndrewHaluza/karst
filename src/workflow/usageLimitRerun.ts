import type { Store } from '../store/db.js';
import type { StageRunResult, StageKey, BlockerKind } from '../model/types.js';
import type { Manifest, AgentProvider } from '../manifest/types.js';
import type { AgentAdapter } from '../agent/adapter.js';
import type { ProcessAssignmentSnapshot } from '../agent/processAssignment.js';
import { claimUsageLimitPark, type UsageLimitParkRow } from '../store/usageLimitParks.js';
import { openGateRun } from './gates/evidence.js';
import { commitGateOutcome, type RecoveryTriggerInput } from './gates/commit.js';
import { closeStageRun } from '../store/stageRuns.js';
import type { GitRunner } from '../integrations/git.js';
import type { ReviewArtifacts } from './review/conformance.js';
import { capForGate, type GateStageKey } from './fixAttempts.js';
import { nowIso } from '../model/time.js';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { listWorktreesByTicket, listServersByTicket } from '../store/dashboard.js';
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
import { listGateRuns } from '../store/gateRuns.js';
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

/** A sibling target's status carried on a UAT park row's `keptOutcome`. */
interface UatKeptTarget {
  repo: string;
  status?: string;
  observations?: number;
}

/** A sibling target's status carried on a Review park row's `keptOutcome`. */
interface ReviewKeptTarget {
  repo: string;
  status?: string;
  findings?: number;
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

/** The options a re-run uses once the claim won and its adapter exists. */
type ClaimedRerunOptions = RerunParkOptions & {
  adapter: AgentAdapter;
  assignment: ProcessAssignmentSnapshot;
};

/**
 * The review targets this re-run must ask: the parked one, plus every target
 * the original lane never reached before the quota stop. Asking only the parked
 * target would commit a verdict that silently never covered the rest.
 */
function reviewTargetsToAsk(
  keptTargets: readonly ReviewKeptTarget[],
  parked: string,
): string[] {
  const seen = new Set<string>();
  const asked: string[] = [];
  const add = (repo: string): void => {
    if (seen.has(repo)) return;
    seen.add(repo);
    asked.push(repo);
  };
  add(parked);
  for (const target of keptTargets) {
    if (target.status === 'not-run') add(target.repo);
  }
  return asked;
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

export async function rerunParkedStage(opts: RerunParkOptions): Promise<StageRunResult> {
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
    return { kind: 'stopped' };
  }

  const stageKey = (parkRow.stage ?? (parkRow.lane === 'uat' ? 'uat' : 'review')) as GateStageKey;
  if (parkRow.lane !== 'review' && parkRow.lane !== 'uat' && stageKey !== 'review' && stageKey !== 'uat') {
    // BEFORE the claim: a park that names no lane this path can run must stay
    // OPEN. Claiming it first would consume it and run nothing — the park would
    // read as handled while its stage is still blocked on the usage limit.
    opts.debug?.(`[usageLimit] park ${parkRow.id} names no re-runnable lane — left open`);
    return { kind: 'stopped' };
  }

  // 1. Claim the park row atomically before building anything or running. A
  // racing window loses here and returns `stopped` without constructing an
  // adapter, opening a stage run, or touching any state.
  const claim = claimUsageLimitPark(store, parkRow.id, opts.resolution ?? 'rerun', runAt);
  if (!claim.claimed) {
    opts.debug?.(`[usageLimit] park ${parkRow.id} already claimed or invalid`);
    return { kind: 'stopped' };
  }

  // 2. Build the adapter ONLY after the claim. The host hands a factory so the
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

  if (parkRow.lane === 'review' || stageKey === 'review') {
    return rerunReviewParkedStage(claimed, { stageKey, runAt, now });
  }

  return rerunUatParkedStage(claimed, { stageKey, runAt, now });
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
  const askedRepos = reviewTargetsToAsk(keptTargets, targetRepo);
  const laneTargets: FindingsLaneTarget[] = askedRepos.map((repo) => {
    const wt = worktrees.find((w) => w.repo === repo);
    return {
      repo,
      worktreePath: wt?.path ?? cwd,
      baseRef: wt?.baseRef ?? null,
      branch: wt?.branch ?? null,
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

  const previousGateRuns = listGateRuns(store, parkRow.ticketId).filter(
    (r) => r.stageKey === 'review' && r.stageRunId === parkRow.stageRunId,
  );
  const entries: AggregateEntry[] = previousGateRuns.map((r) => ({
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

  const targetRepo = parkRow.target ?? cwd;
  const worktrees = listWorktreesByTicket(store, parkRow.ticketId);
  const worktreePath = worktrees.find((w) => w.repo === targetRepo)?.path ?? cwd;

  // Built through the SAME mapper the stage uses (`testerTargets`): the prompt
  // must name this target's base branch, its ticket branch and any service karst
  // already started for it. A bare `{repo, worktreePath}` target told the Tester
  // its change was not live even when a service WAS running.
  const target = testerTargets(
    manifest,
    [{ repo: targetRepo, path: worktreePath, names: manifestNamesFor(manifest, targetRepo) }],
    worktrees,
    listServersByTicket(store, parkRow.ticketId),
  )[0]!;

  const blockingSeverity = manifest?.uat?.testerObservations?.blockingSeverity ?? 'none';
  // The Tester is asked about the SAME ticket the stage asks about: its
  // done-when criteria (`description`), its canonical intent and key. Without
  // them the re-run would judge a different, weaker question than the run it
  // replaces — and a passing re-run could advance on a generic "does it work".
  const ticket = getTicket(store, parkRow.ticketId);
  const testerResult = await runUatTester(
    store,
    {
      ticketId: parkRow.ticketId,
      targets: [target],
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
      `! re-run parked uat: target ${targetRepo} with ${assignment.provider}/${assignment.model ?? 'default'}\n`,
    );
  }

  // Parse the sibling observations AND target statuses the earlier park kept.
  // Both must survive a re-park: the observations to count (they are already
  // durable from the run that made them), the target statuses to carry forward
  // on the next park row.
  const siblingObservations: UatFindingInput[] = [];
  const siblingTargets: UatKeptTarget[] = [];
  try {
    if (parkRow.keptOutcome) {
      const parsed = JSON.parse(parkRow.keptOutcome);
      if (Array.isArray(parsed.observations)) {
        for (const obs of parsed.observations) {
          if (obs && typeof obs === 'object' && typeof obs.severity === 'string' && typeof obs.title === 'string') {
            siblingObservations.push({
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
            siblingTargets.push(t as UatKeptTarget);
          }
        }
      }
    }
  } catch {
    // Ignore malformed keptOutcome
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
        cwd: target.worktreePath ?? cwd,
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

  // Gates passed, the Tester had no blocking observations, and the verifier
  // (when configured) passed.
  return commitGateOutcome(store, {
    ticketId: parkRow.ticketId,
    stageKey,
    runAt,
    artifactPath,
    gates: [],
    outcome: {
      kind: 'verdict',
      verdict: { kind: 'passed' },
    },
    stageRunId: newStageRunId,
    now,
    debug,
  });
}

