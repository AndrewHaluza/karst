import type { Store } from '../store/db.js';
import type { StageRunResult, StageKey, BlockerKind } from '../model/types.js';
import type { Manifest, AgentProvider } from '../manifest/types.js';
import type { AgentAdapter } from '../agent/adapter.js';
import { claimUsageLimitPark, type UsageLimitParkRow } from '../store/usageLimitParks.js';
import { openStageRun } from '../store/stageRuns.js';
import { stageAttempt } from '../store/stages.js';
import { openGateRun } from './gates/evidence.js';
import { commitGateOutcome, type RecoveryTriggerInput } from './gates/commit.js';
import type { GitRunner } from '../integrations/git.js';
import type { ReviewArtifacts } from './review/conformance.js';
import { capForGate, type GateStageKey } from './fixAttempts.js';
import { nowIso } from '../model/time.js';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { listWorktreesByTicket } from '../store/dashboard.js';
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
  type TesterTarget,
} from './uat/tester.js';
import {
  listUatFindings,
  recordUatFindings,
  type UatFindingInput,
} from '../store/uatFindings.js';
import {
  runTesterVerifier,
  TESTER_VERIFIER_FAILURE_PREFIX,
  TESTER_OBSERVATIONS_FAILURE_PREFIX,
  type TesterGateRunner,
} from './uat/testerVerifier.js';

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
 *   2. Opens its OWN new stage run via openStageRun.
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
  const attempt = stageAttempt(store, park.ticketId, stageKey);
  const runAt = now();

  const newStageRunId = openStageRun(store, {
    ticketId: park.ticketId,
    stageKey,
    attempt,
    runAt,
    startedAt: runAt,
    pid: process.pid,
  });

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
  adapter: AgentAdapter;
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
}

export async function rerunParkedStage(opts: RerunParkOptions): Promise<StageRunResult> {
  const store = opts.store;
  const parkRow = opts.parkRow;
  const now = opts.now ?? nowIso;
  const runAt = now();

  // 1. Claim the park row atomically before building anything or running.
  const claim = claimUsageLimitPark(store, parkRow.id, opts.resolution ?? 'rerun', runAt);
  if (!claim.claimed) {
    opts.debug?.(`[usageLimit] park ${parkRow.id} already claimed or invalid`);
    return { kind: 'stopped' };
  }

  const stageKey = (parkRow.stage ?? (parkRow.lane === 'uat' ? 'uat' : 'review')) as GateStageKey;

  if (parkRow.lane === 'review' || stageKey === 'review') {
    return rerunReviewParkedStage(opts, { stageKey, runAt, now });
  }

  if (parkRow.lane === 'uat' || stageKey === 'uat') {
    return rerunUatParkedStage(opts, { stageKey, runAt, now });
  }

  return { kind: 'stopped' };
}

async function rerunReviewParkedStage(
  opts: RerunParkOptions,
  ctx: { stageKey: GateStageKey; runAt: string; now: () => string },
): Promise<StageRunResult> {
  const { store, parkRow, provider, model, adapter, manifest, cwd, artifactDir, signal, debug } = opts;
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
  const wt = worktrees.find((w) => w.repo === targetRepo) ?? {
    repo: targetRepo,
    path: cwd,
    baseRef: null,
    branch: null,
  };

  const laneTarget: FindingsLaneTarget = {
    repo: targetRepo,
    worktreePath: wt.path ?? cwd,
    baseRef: wt.baseRef ?? null,
    branch: wt.branch ?? null,
  };

  const config = {
    ...DEFAULT_REVIEW_FINDINGS,
    ...(manifest?.review?.findings ?? {}),
  };
  const overrideProcess: FindingsProcessInput = {
    assignment: {
      provider,
      ...(model !== null ? { model } : {}),
    },
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
      artifacts = loaded ? { ...loaded, targets: [targetRepo] } : undefined;
    } catch (err) {
      debug?.(`[gate] review ticket ${parkRow.ticketId}: artifacts unavailable (${String(err)})`);
    }
  }

  const laneOutcome = await runFindingsLane({
    config,
    adapter,
    targets: [laneTarget],
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
    return { kind: 'stopped' };
  }

  // Parse sibling targets from keptOutcome if any
  let keptTargets: { repo: string; status: string; findings: number }[] = [];
  try {
    if (parkRow.keptOutcome) {
      const parsed = JSON.parse(parkRow.keptOutcome);
      if (Array.isArray(parsed.targets)) {
        keptTargets = parsed.targets;
      }
    }
  } catch {
    // Ignore malformed keptOutcome
  }

  // Sibling targets count + the current target
  const siblingCount = keptTargets.filter((t) => t.repo !== targetRepo).length;
  const totalTargetCount = siblingCount + 1;
  const siblingUnreadable = keptTargets
    .filter((t) => t.repo !== targetRepo && t.status === 'unreadable')
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
    `! re-run parked review: target ${targetRepo} with ${provider}/${model ?? 'default'}`,
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
    const maxRounds = capForGate('review', manifest?.uat?.maxFixAttempts, manifest?.review?.maxFixAttempts);
    recoveryTrigger = {
      sourceProcessId: 'review',
      sourceStageRunId: newStageRunId,
      sourceProcessRunId: processRunId,
      triggerKind: 'blocking-review-findings',
      triggerDetail: reason,
      maxRounds,
    };
  }

  return commitGateOutcome(store, {
    ticketId: parkRow.ticketId,
    stageKey,
    runAt,
    artifactPath,
    gates: previousGateRuns.map((r) => ({
      gateName: r.gateName,
      exitCode: r.exitCode,
      startedAt: r.startedAt ?? undefined,
      endedAt: r.endedAt ?? undefined,
      repo: r.repo ?? undefined,
      command: r.command ?? undefined,
      args: r.args ?? undefined,
      skipped: r.skipped,
      summary: r.summary ?? undefined,
    })),
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
  opts: RerunParkOptions,
  ctx: { stageKey: GateStageKey; runAt: string; now: () => string },
): Promise<StageRunResult> {
  const { store, parkRow, provider, model, adapter, manifest, cwd, artifactDir, signal, debug } = opts;
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
  const wt = worktrees.find((w) => w.repo === targetRepo) ?? {
    repo: targetRepo,
    path: cwd,
    baseRef: null,
    branch: null,
  };

  const target: TesterTarget = {
    repo: targetRepo,
    worktreePath: wt.path ?? cwd,
    baseRef: wt.baseRef ?? null,
    branch: wt.branch ?? null,
  };

  const blockingSeverity = manifest?.uat?.testerObservations?.blockingSeverity ?? 'none';
  const testerResult = await runUatTester(
    store,
    {
      ticketId: parkRow.ticketId,
      targets: [target],
      assignment: {
        provider,
        ...(model !== null ? { model } : {}),
      },
      adapter,
      stageRunId: newStageRunId,
      attempt,
      signal,
      debug,
      observationsBlockingSeverity: blockingSeverity,
      tokenBudget: manifest?.uat?.tester?.tokenBudget,
    },
    { now },
  );

  if (testerResult.kind === 'interrupted') {
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

  mkdirSync(artifactDir, { recursive: true });
  const artifactPath = join(artifactDir, `uat-ticket-${parkRow.ticketId}-${newStageRunId}.log`);
  writeFileSync(
    artifactPath,
    `! re-run parked uat: target ${targetRepo} with ${provider}/${model ?? 'default'}\n`,
  );

  const previousGateRuns = listGateRuns(store, parkRow.ticketId).filter(
    (r) => r.stageKey === 'uat' && r.stageRunId === parkRow.stageRunId,
  );
  const gates = previousGateRuns.map((r) => ({
    gateName: r.gateName,
    exitCode: r.exitCode,
    startedAt: r.startedAt ?? undefined,
    endedAt: r.endedAt ?? undefined,
    repo: r.repo ?? undefined,
    command: r.command ?? undefined,
    args: r.args ?? undefined,
    skipped: r.skipped,
    summary: r.summary ?? undefined,
  }));

  // Parse sibling observations from keptOutcome
  const siblingObservations: UatFindingInput[] = [];
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
    }
  } catch {
    // Ignore malformed keptOutcome
  }

  // If there are sibling observations and we have a tester process run, record them into uat_findings
  if (siblingObservations.length > 0 && testerRunId !== null) {
    recordUatFindings(store, {
      ticketId: parkRow.ticketId,
      processRunId: testerRunId,
      findings: siblingObservations,
      createdAt: now(),
    });
  }

  // Calculate merged blocking count across newly observed findings and sibling observations
  let combinedBlocking = 0;
  let combinedSummary: string | undefined;
  if (testerResult.kind === 'observed' || testerResult.kind === 'partial') {
    const newlyObservedFindings = listUatFindings(store, parkRow.ticketId)
      .filter((f) => testerRunId !== null && f.processRunId === testerRunId)
      .map((f) => ({
        severity: f.severity,
        repo: f.repo,
        file: f.filePath,
        line: f.line,
        title: f.title,
      }));
    const allObservations = [...newlyObservedFindings];
    const counted = countBlockingObservations(allObservations, blockingSeverity);
    combinedBlocking = counted.blocking;
    combinedSummary = counted.blockingSummary;
  } else if (siblingObservations.length > 0) {
    const counted = countBlockingObservations(siblingObservations, blockingSeverity);
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
      gates,
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
      gates,
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
          keptOutcome: testerResult.keptOutcome,
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
          gates,
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
          gates,
          outcome: { kind: 'blocked', blocker: 'capability-missing', reason },
          stageRunId: newStageRunId,
          now,
          debug,
        });
      }
      case 'interrupted':
        return { kind: 'stopped' };
    }
  }

  // The opt-in observation threshold, AFTER the verifier so the deterministic
  // boundary keeps precedence — exactly the stage's order.
  if (
    (testerResult.kind === 'observed' || testerResult.kind === 'partial') &&
    combinedBlocking > 0
  ) {
    const reason = `${TESTER_OBSERVATIONS_FAILURE_PREFIX}${combinedSummary ?? `${combinedBlocking} blocking`}`;
    const maxRounds = capForGate('uat', manifest?.uat?.maxFixAttempts, manifest?.review?.maxFixAttempts);
    return commitGateOutcome(store, {
      ticketId: parkRow.ticketId,
      stageKey,
      runAt,
      artifactPath,
      gates,
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
    gates,
    outcome: {
      kind: 'verdict',
      verdict: { kind: 'passed' },
    },
    stageRunId: newStageRunId,
    now,
    debug,
  });
}

