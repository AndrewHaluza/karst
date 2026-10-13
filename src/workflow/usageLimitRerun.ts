import type { Store } from '../store/db.js';
import type { StageRunResult, StageKey, BlockerKind } from '../model/types.js';
import type { Manifest, AgentProvider } from '../manifest/types.js';
import type { AgentAdapter } from '../agent/adapter.js';
import { claimUsageLimitPark, type UsageLimitParkRow } from '../store/usageLimitParks.js';
import { openStageRun } from '../store/stageRuns.js';
import { stageAttempt } from '../store/stages.js';
import { commitGateOutcome, type RecoveryTriggerInput } from './gates/commit.js';
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
import { listFindings, type FindingInput } from '../store/reviewFindings.js';
import {
  aggregateReview,
  DEFAULT_REVIEW_FINDINGS,
  uatIdentitiesFrom,
  FINDINGS_FAILURE_PREFIX,
  type AggregateEntry,
  type FindingsLaneOutcome,
} from './review/aggregate.js';
import { listGateRuns } from '../store/gateRuns.js';
import { finishProcessRun, listProcessRuns } from '../store/processRuns.js';
import { collapseDiagnostic } from '../model/diagnosticText.js';
import {
  runUatTester,
  type TesterTarget,
} from './uat/tester.js';
import { TESTER_OBSERVATIONS_FAILURE_PREFIX } from './uat/testerVerifier.js';

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
  cwd: string;
  artifactDir: string;
  signal?: AbortSignal;
  now?: () => string;
  debug?: (m: string) => void;
}

export async function rerunParkedStage(opts: RerunParkOptions): Promise<StageRunResult> {
  const store = opts.store;
  const parkRow = opts.parkRow;
  const now = opts.now ?? nowIso;
  const runAt = now();

  // 1. Claim the park row atomically before building anything or running.
  const claim = claimUsageLimitPark(store, parkRow.id, 'rerun', runAt);
  if (!claim.claimed) {
    opts.debug?.(`[usageLimit] park ${parkRow.id} already claimed or invalid`);
    return { kind: 'stopped' };
  }

  const stageKey = (parkRow.stage ?? (parkRow.lane === 'uat' ? 'uat' : 'review')) as GateStageKey;
  const attempt = stageAttempt(store, parkRow.ticketId, stageKey);

  if (parkRow.lane === 'review' || stageKey === 'review') {
    return rerunReviewParkedStage(opts, { stageKey, attempt, runAt, now });
  }

  if (parkRow.lane === 'uat' || stageKey === 'uat') {
    return rerunUatParkedStage(opts, { stageKey, attempt, runAt, now });
  }

  return { kind: 'stopped' };
}

async function rerunReviewParkedStage(
  opts: RerunParkOptions,
  ctx: { stageKey: GateStageKey; attempt: number; runAt: string; now: () => string },
): Promise<StageRunResult> {
  const { store, parkRow, provider, model, adapter, manifest, cwd, artifactDir, signal, debug } = opts;
  const { stageKey, attempt, runAt, now } = ctx;

  const newStageRunId = openStageRun(store, {
    ticketId: parkRow.ticketId,
    stageKey,
    attempt,
    runAt,
    startedAt: runAt,
    pid: process.pid,
  });

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
      model,
      role: 'review',
    },
    adapter,
    stageRunId: newStageRunId,
    attempt,
    pid: process.pid,
    startedAt: runAt,
  };

  const laneOutcome = await runFindingsLane({
    config,
    adapter,
    targets: [laneTarget],
    ticketId: parkRow.ticketId,
    signal,
    store,
    process: overrideProcess,
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

  // Retrieve sibling findings from store (from previous target runs under this ticket/attempt)
  const existingFindings = listFindings(store, parkRow.ticketId);
  // Current newly found findings
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

  const effectiveLaneOutcome: FindingsLaneOutcome =
    laneOutcome.kind === 'ran'
      ? {
          kind: 'ran',
          findings: mergedFindings,
          crashes: laneOutcome.crashes,
          unreadable: laneOutcome.unreadable,
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
      repo: r.repo ?? undefined,
      command: r.command ?? undefined,
      args: r.args ?? undefined,
    },
  }));

  const uatIdentities = uatIdentitiesFrom(listGateRuns(store, parkRow.ticketId));
  const blockingSeverity = config.blockingSeverity;

  const aggregateOutcome = aggregateReview(entries, uatIdentities, effectiveLaneOutcome, {
    requireIndependentSignal: manifest?.review?.requireIndependentSignal ?? false,
    findingsBlockingSeverity: blockingSeverity,
    disabledGateNames: [],
  });

  const processRunId = laneOutcome.kind === 'ran' ? (laneOutcome.processRunId ?? null) : null;
  if (processRunId !== null) {
    const blocking =
      aggregateOutcome.kind === 'verdict' &&
      aggregateOutcome.verdict.kind === 'failed' &&
      (aggregateOutcome.verdict.reason ?? '').startsWith(FINDINGS_FAILURE_PREFIX);
    const unreadableBlock =
      effectiveLaneOutcome.kind === 'ran' &&
      (effectiveLaneOutcome.unreadable?.length ?? 0) > 0 &&
      effectiveLaneOutcome.findings.length === 0 &&
      aggregateOutcome.kind === 'blocked' &&
      aggregateOutcome.blocker === 'capability-missing';

    mkdirSync(artifactDir, { recursive: true });
    const logPath = join(artifactDir, `review-ticket-${parkRow.ticketId}-${newStageRunId}.log`);

    if ((laneOutcome.crashes?.length ?? 0) > 0 || unreadableBlock) {
      const uniqueCrashes = [...new Set(laneOutcome.crashes ?? [])];
      finishProcessRun(
        store,
        processRunId,
        'failed',
        now(),
        'execution-failed',
        logPath,
        uniqueCrashes.length > 0 ? collapseDiagnostic(uniqueCrashes.join('; ')) : null,
      );
    } else if (blocking) {
      finishProcessRun(store, processRunId, 'failed', now(), 'blocking', logPath);
    } else {
      finishProcessRun(store, processRunId, 'passed', now(), 'validated', logPath);
    }
  }

  mkdirSync(artifactDir, { recursive: true });
  const artifactPath = join(artifactDir, `review-ticket-${parkRow.ticketId}-${newStageRunId}.log`);
  writeFileSync(
    artifactPath,
    `! re-run parked review: target ${targetRepo} with ${provider}/${model ?? 'default'}\n`,
  );

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
    findings: mergedFindings,
    stageRunId: newStageRunId,
    recoveryTrigger,
    now,
    debug,
  });
}

async function rerunUatParkedStage(
  opts: RerunParkOptions,
  ctx: { stageKey: GateStageKey; attempt: number; runAt: string; now: () => string },
): Promise<StageRunResult> {
  const { store, parkRow, provider, model, adapter, manifest, cwd, artifactDir, signal, debug } = opts;
  const { stageKey, attempt, runAt, now } = ctx;

  const newStageRunId = openStageRun(store, {
    ticketId: parkRow.ticketId,
    stageKey,
    attempt,
    runAt,
    startedAt: runAt,
    pid: process.pid,
  });

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
        model,
        role: 'tester',
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

  if (
    (testerResult.kind === 'observed' || testerResult.kind === 'partial') &&
    testerResult.blocking > 0
  ) {
    const reason = `${TESTER_OBSERVATIONS_FAILURE_PREFIX}${testerResult.blockingSummary ?? `${testerResult.blocking} blocking`}`;
    const maxRounds = capForGate('uat', manifest?.uat?.maxFixAttempts, manifest?.review?.maxFixAttempts);
    return commitGateOutcome(store, {
      ticketId: parkRow.ticketId,
      stageKey,
      runAt,
      artifactPath,
      gates,
      outcome: {
        kind: 'verdict',
        verdict: { kind: 'failed', reason },
      },
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

  // Gates passed, tester had no blocking observations
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

