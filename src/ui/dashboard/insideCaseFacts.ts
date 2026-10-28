import type { StepperCell } from '../../model/stepper.js';
import type { StageKey, StageStatus } from '../../model/types.js';
import { STAGE_KEYS } from '../../model/types.js';
import type { InsideStageKey, InsideStageView } from '../../model/inside/types.js';
import type { ServiceStatusView } from '../../model/inside/gates.js';
import type { SessionConfiguredInput } from '../../model/inside/agent.js';
import type { GateRun } from '../../store/gateRuns.js';
import type { ProcessRun } from '../../store/processRuns.js';
import type { StageRun } from '../../store/stageRuns.js';
import type { Finding } from '../../store/reviewFindings.js';
import type { UatFinding } from '../../store/uatFindings.js';
import type { RecoveryRound } from '../../store/recoveryRoundsRead.js';
import type { RoundWithDelivery } from '../../model/inside/recovery.js';
import { buildGateSwitches } from './stateGates.js';
import { buildInsideViews } from './stateInside.js';

/**
 * Fixed store-shaped rows for one Inside case, and the projection that turns
 * them into the six `InsideStageView`s through the SAME reducers production
 * uses (`buildGateSwitches` → `buildInsideViews`). A copy change in the model
 * therefore shows in the case baselines. Pure data: no store, no clock.
 */

/** The frozen clock every case reads. */
export const CASE_NOW = '2026-10-27T10:00:00.000Z';

export const CASE_WEB = '/wt/web';
export const CASE_API = '/wt/api';

export interface CaseFacts {
  cells?: Partial<Record<StageKey, Partial<StepperCell>>>;
  stageCurrent?: StageKey;
  gateRuns?: readonly GateRun[];
  processRuns?: readonly ProcessRun[];
  stageRuns?: readonly StageRun[];
  rounds?: readonly RoundWithDelivery[];
  findings?: readonly Finding[];
  uatFindings?: readonly UatFinding[];
  services?: readonly ServiceStatusView[];
  attemptSelection?: Partial<Record<'uat' | 'review', string>>;
  resolvedGates?: { uat: readonly { name: string; disabled: boolean }[]; review: readonly { name: string; disabled: boolean }[] };
  findingsRepoSelection?: Partial<Record<'uat' | 'review', string>>;
  reviewBlockingSeverity?: 'critical' | 'high' | 'medium' | 'low' | 'info' | 'none';
}

const at = (minute: number): string => `2026-10-27T09:${String(minute).padStart(2, '0')}:00.000Z`;
export const caseTime = at;

/** One stage cell; `status` decides the stamps a real cell would carry. */
export function caseCell(stageKey: StageKey, status: StageStatus, over: Partial<StepperCell> = {}): StepperCell {
  const started = status === 'pending' ? {} : { startedAt: at(10), attempt: 1 };
  const ended = status === 'passed' || status === 'failed' || status === 'bypassed' ? { endedAt: at(20) } : {};
  return { stageKey, status, ...started, ...ended, ...over };
}

export function caseGate(over: Partial<GateRun> & Pick<GateRun, 'id' | 'stageKey' | 'gateName' | 'exitCode'>): GateRun {
  return {
    ticketId: 1,
    attempt: 1,
    runAt: at(10),
    startedAt: at(10),
    endedAt: at(11),
    repo: CASE_WEB,
    command: 'npm',
    args: ['run', over.gateName],
    skipped: false,
    stageRunId: null,
    summary: null,
    ...over,
  };
}

export function caseStageRun(over: Partial<StageRun> & Pick<StageRun, 'id' | 'stageKey'>): StageRun {
  return {
    ticketId: 1,
    attempt: 1,
    runAt: at(10),
    status: 'finished',
    outcome: 'advanced',
    manifestHash: null,
    pid: null,
    startedAt: at(10),
    endedAt: at(20),
    ...over,
  };
}

export function caseProcessRun(over: Partial<ProcessRun> & Pick<ProcessRun, 'id' | 'stageKey' | 'processId'>): ProcessRun {
  return {
    ticketId: 1,
    attempt: 1,
    stageRunId: null,
    agentName: 'tester',
    provider: 'claude',
    model: 'claude-opus-4-1',
    pid: null,
    status: 'passed',
    resultKind: null,
    artifactPath: null,
    failureDetail: null,
    promptTelemetry: null,
    startedAt: at(12),
    endedAt: at(18),
    ...over,
  };
}

export function caseRound(
  over: Partial<RecoveryRound> & Pick<RecoveryRound, 'id' | 'sourceStage' | 'round'>,
): RoundWithDelivery {
  return {
    ticketId: 1,
    sourceProcessId: over.sourceStage === 'review' ? 'review' : 'gates',
    sourceStageRunId: null,
    sourceProcessRunId: null,
    triggerKind: over.sourceStage === 'review' ? 'blocking-review-findings' : 'gate-failure',
    triggerDetail: over.sourceStage === 'review' ? '2 blocking findings' : 'gates failed: test (web)',
    episode: 1,
    maxRounds: 3,
    fixProcessRunId: null,
    uatRevalidationStageRunId: null,
    reviewRevalidationStageRunId: null,
    status: 'passed',
    startedAt: at(21),
    endedAt: at(30),
    interruptCount: 0,
    ...over,
  };
}

export function caseFinding(over: Partial<Finding> & Pick<Finding, 'id' | 'severity' | 'title'>): Finding {
  return {
    ticketId: 1,
    attempt: 1,
    runAt: at(15),
    processRunId: null,
    repo: CASE_WEB,
    file: 'src/picker/override.ts',
    line: 42,
    detail: 'The override is applied before the base ref is resolved.',
    source: 'agent',
    createdAt: at(16),
    ...over,
  };
}

export const CASE_CONFIGURED: SessionConfiguredInput = {
  provider: 'claude',
  model: 'claude-opus-4-1',
  effort: null,
} as unknown as SessionConfiguredInput;

/**
 * Project fixed rows onto the six Inside views. Stages without a cell in
 * `facts.cells` read as pending, exactly as an unentered stage does.
 */
export function buildCaseViews(facts: CaseFacts): Record<InsideStageKey, InsideStageView> {
  const cellOf = (key: StageKey): StepperCell => {
    const over = facts.cells?.[key];
    return caseCell(key, over?.status ?? 'pending', over);
  };
  const stepper = STAGE_KEYS.map(cellOf);
  const rounds = facts.rounds ?? [];
  const gateRuns = facts.gateRuns ?? [];
  const processRuns = facts.processRuns ?? [];
  const switches = buildGateSwitches({
    ticket: { stageCurrent: facts.stageCurrent ?? null },
    rounds,
    gateRuns,
    processRuns,
    cellOf,
    stageRuns: facts.stageRuns ?? [],
    attemptSelection: facts.attemptSelection,
  });
  return buildInsideViews({
    cellOf,
    selectedRepos: ['web', 'api'],
    worktrees: [],
    agentWaiting: false,
    now: CASE_NOW,
    processRuns,
    timeline: null,
    segmentTokens: [],
    marks: [],
    assignmentFor: () => CASE_CONFIGURED,
    tokensFor: () => null,
    attach: () => undefined,
    gateRuns,
    findings: facts.findings ?? [],
    uatFindings: facts.uatFindings ?? [],
    rounds,
    services: facts.services ?? [],
    resolvedGates: facts.resolvedGates,
    findingsRepoSelection: facts.findingsRepoSelection,
    repoNameFor: (repo) => (repo === CASE_WEB ? 'web' : repo === CASE_API ? 'api' : undefined),
    graphInsideProcessOnce: null,
    uatSwitch: switches.uatSwitch,
    reviewSwitch: switches.reviewSwitch,
    uatRoundSwitcher: switches.uatRoundSwitcher,
    reviewRoundSwitcher: switches.reviewRoundSwitcher,
    uatCurrent: switches.uatCurrent,
    reviewCurrent: switches.reviewCurrent,
    shipEvidence: { run: undefined, repos: {} },
    prs: [],
    mergeChecks: [],
    shipFindings: [],
    findingsBlockingSeverity: 'none',
    reviewBlockingSeverity: facts.reviewBlockingSeverity ?? 'high',
    stepper,
    recordedTotal: { input: 0, output: 0, total: 0, cacheRead: 0 },
    roleTokens: [],
    stageCurrent: facts.stageCurrent ?? null,
  });
}
