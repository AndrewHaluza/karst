import type { DashboardState } from './state.js';
import type { InsideStageKey, InsideStageView } from '../../model/inside/types.js';
import type { StageKey } from '../../model/types.js';
import { populatedStateFor, renderFixtures, shipPreviewStateFor } from './renderFixtures.js';
import {
  buildCaseViews,
  caseCell,
  caseFinding,
  caseGate,
  caseProcessRun,
  caseRound,
  caseStageRun,
  caseTime as t,
  CASE_API,
  CASE_WEB,
  type CaseFacts,
} from './insideCaseFacts.js';

/**
 * The per-stage Inside case registry (ui:VISUAL-VARIANTS): every stage ×
 * state case the Inside block can show, as one full `DashboardState`. Each
 * case becomes the dashboard variant `inside-<stage>-<id>`.
 *
 * Views come from fixed store-shaped rows run through the real reducers
 * (`insideCaseFacts.buildCaseViews`) wherever a selector exists, so a copy
 * change in `src/model/inside/*` shows in the baselines. A case marked
 * HAND-WRITTEN reuses a `renderFixtures.ts` view (no selector input exists
 * for it in this registry) and patches only the envelope.
 */

export interface InsideCase {
  readonly stage: InsideStageKey;
  readonly id: string;
  /** The ticket's current runtime stage when it differs from `stage`. */
  readonly state: () => DashboardState;
  /** Already registered as this dashboard variant (ledger-keyed); no second baseline. */
  readonly aliasOf?: string;
}

/** Build a case from rows: `current` is the stage the ticket sits on. */
function fromFacts(
  stage: InsideStageKey,
  facts: CaseFacts,
  patch: (s: DashboardState) => DashboardState = (s) => s,
): () => DashboardState {
  return () => {
    const views = buildCaseViews({ ...facts, stageCurrent: facts.stageCurrent ?? (stage as StageKey) });
    const base = populatedStateFor(stage);
    const cell = facts.cells?.[stage as StageKey];
    return patch({
      ...base,
      insideViews: views,
      currentStage: cell ? caseCell(stage as StageKey, cell.status ?? 'pending', cell) : null,
    });
  };
}

/** HAND-WRITTEN: the legacy matrix view of a stage (2 repos), envelope patched. */
function legacy(stage: InsideStageKey, patch: (s: DashboardState, v: InsideStageView) => DashboardState = (s) => s): () => DashboardState {
  return () => {
    const f = renderFixtures().find((x) => x.repositoryCount === 2 && x.stage === stage);
    if (!f) throw new Error(`insideCases: no legacy ${stage} view`);
    const base = populatedStateFor(stage);
    return patch({ ...base, insideViews: { ...base.insideViews, [stage]: f.view } }, f.view);
  };
}

// ----------------------------------------------------------- gate-stage rows

const FAILED_GATE = { gateName: 'test (web)', exitCode: 1, summary: '3 tests failed in override.test.ts' } as const;

type Gate = 'uat' | 'review';

/** Round 1 failed (stage run 1); round 2 passed (run 2) or is live (no rows yet). */
function loopFacts(stage: Gate, round2: 'live' | 'passed' | 'failed', extra: Partial<CaseFacts> = {}): CaseFacts {
  const source = stage === 'review' ? ('review' as const) : ('uat' as const);
  const status = round2 === 'live' ? 'running' : round2 === 'passed' ? 'passed' : 'failed';
  const gates = [
    caseGate({ id: 1, stageKey: stage, stageRunId: 1, runAt: t(10), ...FAILED_GATE }),
    ...(round2 === 'live'
      ? []
      : [
          caseGate({
            id: 2,
            stageKey: stage,
            stageRunId: 2,
            runAt: t(35),
            gateName: 'test (web)',
            exitCode: round2 === 'passed' ? 0 : 1,
            summary: round2 === 'passed' ? null : FAILED_GATE.summary,
          }),
        ]),
  ];
  return {
    cells: { [stage]: { status, startedAt: t(33), ...(round2 === 'live' ? {} : { endedAt: t(40) }) } },
    gateRuns: gates,
    stageRuns: [
      caseStageRun({ id: 1, stageKey: stage, runAt: t(10), startedAt: t(10), endedAt: t(20) }),
      caseStageRun({
        id: 2,
        stageKey: stage,
        runAt: t(35),
        startedAt: t(34),
        status: round2 === 'live' ? 'running' : 'finished',
        endedAt: round2 === 'live' ? null : t(40),
      }),
    ],
    rounds: [
      caseRound({
        id: 1,
        sourceStage: source,
        round: 1,
        sourceStageRunId: 1,
        status: round2 === 'live' ? 'fixing' : 'passed',
        endedAt: round2 === 'live' ? null : t(30),
      }),
    ],
    ...extra,
  };
}

/** Three rounds, all spent: the third gate batch fails and the fix budget is gone. */
function exhaustedFacts(stage: Gate): CaseFacts {
  const run = (n: number) => caseStageRun({ id: n, stageKey: stage, runAt: t(10 * n), startedAt: t(10 * n), endedAt: t(10 * n + 5) });
  return {
    cells: { [stage]: { status: 'failed', startedAt: t(30), endedAt: t(36) } },
    gateRuns: [1, 2, 3].map((n) => caseGate({ id: n, stageKey: stage, stageRunId: n, runAt: t(10 * n), ...FAILED_GATE })),
    stageRuns: [run(1), run(2), run(3)],
    rounds: [1, 2, 3].map((n) =>
      caseRound({
        id: n,
        sourceStage: stage,
        round: n,
        sourceStageRunId: n,
        status: n === 3 ? 'exhausted' : 'failed',
      }),
    ),
  };
}

const uatTesterRun = (over: Parameters<typeof caseProcessRun>[0] extends infer P ? Partial<P> : never = {}) =>
  caseProcessRun({ id: 11, stageKey: 'uat', processId: 'tester', ...over });
const reviewRun = (over: Parameters<typeof caseProcessRun>[0] extends infer P ? Partial<P> : never = {}) =>
  caseProcessRun({ id: 21, stageKey: 'review', processId: 'review', agentName: 'reviewer', ...over });

const BLOCKING = [
  caseFinding({ id: 1, severity: 'high', title: 'Override applied before the base ref resolves', processRunId: 21 }),
  caseFinding({ id: 2, severity: 'critical', title: 'Picker crashes on an empty candidate list', file: 'src/picker/list.ts', line: 7, processRunId: 21 }),
];
const MULTI_REPO = [
  ...BLOCKING,
  caseFinding({ id: 3, severity: 'high', title: 'API resolver ignores the override', repo: CASE_API, file: 'src/resolve.ts', line: 90, processRunId: 21 }),
];

/** A usage-limit park on a gate stage (V82): non-resumable, the banner carries the actions. */
const USAGE_PARK = {
  kind: 'usage-limit' as const,
  reason: 'anthropic: monthly quota exceeded',
  at: t(25),
  resumable: false,
};

const parkPatch = (blocked: NonNullable<DashboardState['currentStage']>['blocked']) => (s: DashboardState): DashboardState => ({
  ...s,
  currentStage: s.currentStage ? { ...s.currentStage, blocked } : s.currentStage,
});

// ------------------------------------------------------------------- registry

export const INSIDE_CASES: readonly InsideCase[] = [
  // scope
  { stage: 'scope', id: 'pending', state: fromFacts('scope', {}) },
  { stage: 'scope', id: 'running', state: fromFacts('scope', { cells: { scope: { status: 'running' } } }) },
  { stage: 'scope', id: 'passed', state: fromFacts('scope', { cells: { scope: { status: 'passed' } } }) },
  {
    stage: 'scope',
    id: 'needs-you',
    state: fromFacts('scope', { cells: { scope: { status: 'running' } } }, (s) => ({ ...s, agentState: 'waiting' })),
  },

  // impl — HAND-WRITTEN session timeline (no store timeline rows in this registry)
  { stage: 'impl', id: 'pending', state: fromFacts('impl', {}) },
  { stage: 'impl', id: 'running', state: legacy('impl') },
  {
    stage: 'impl',
    id: 'interrupted',
    state: legacy('impl', (s) => ({ ...s, agentState: 'interrupted' })),
  },
  {
    stage: 'impl',
    id: 'fix-pending-delivery',
    state: legacy('impl', (s, v) => ({
      ...s,
      insideViews: {
        ...s.insideViews,
        impl: { ...v, live: { label: 'Fix brief not yet delivered to the session', status: 'wait' } as InsideStageView['live'] },
      },
    })),
  },
  { stage: 'impl', id: 'passed', state: fromFacts('impl', { cells: { impl: { status: 'passed' } } }) },

  // uat
  { stage: 'uat', id: 'pending', state: fromFacts('uat', {}) },
  {
    stage: 'uat',
    id: 'services-booting',
    state: fromFacts('uat', {
      cells: { uat: { status: 'running' } },
      services: [{ service: 'web', status: 'stopped', host: null, port: null }],
    }),
  },
  {
    stage: 'uat',
    id: 'running',
    state: fromFacts('uat', {
      cells: { uat: { status: 'running' } },
      gateRuns: [caseGate({ id: 1, stageKey: 'uat', gateName: 'test (web)', exitCode: 0 })],
      processRuns: [uatTesterRun({ status: 'running', endedAt: null })],
      services: [{ service: 'web', status: 'running', host: 'localhost', port: 5173 }],
    }),
  },
  {
    stage: 'uat',
    id: 'passed',
    state: fromFacts('uat', {
      cells: { uat: { status: 'passed' } },
      gateRuns: [caseGate({ id: 1, stageKey: 'uat', gateName: 'test (web)', exitCode: 0 })],
      processRuns: [uatTesterRun()],
    }),
  },
  { stage: 'uat', id: 'fix-running', state: fromFacts('uat', loopFacts('uat', 'live')) },
  { stage: 'uat', id: 'passed-round-2', state: fromFacts('uat', loopFacts('uat', 'passed')) },
  {
    stage: 'uat',
    id: 'older-round',
    state: fromFacts('uat', loopFacts('uat', 'passed', { attemptSelection: { uat: 'sr:1' } })),
  },
  { stage: 'uat', id: 'exhausted', state: fromFacts('uat', exhaustedFacts('uat')) },
  {
    stage: 'uat',
    id: 'boot-failed',
    state: fromFacts(
      'uat',
      {
        cells: { uat: { status: 'running' } },
        services: [{ service: 'web', status: 'failed', host: null, port: null, reason: 'nothing listening on :5173 after 30s' }],
      },
      parkPatch({ kind: 'boot-failed', reason: 'nothing listening on :5173 after 30s', at: t(25), resumable: true }),
    ),
  },
  {
    stage: 'uat',
    id: 'usage-limit',
    state: fromFacts('uat', { cells: { uat: { status: 'running' } }, processRuns: [uatTesterRun({ status: 'running', endedAt: null })] }, parkPatch(USAGE_PARK)),
  },
  {
    stage: 'uat',
    id: 'bypassed',
    state: fromFacts('uat', {
      cells: { uat: { status: 'bypassed' } },
      resolvedGates: { uat: [{ name: 'test (web)', disabled: true }], review: [] },
    }),
  },

  // review
  { stage: 'review', id: 'pending', state: fromFacts('review', {}) },
  {
    stage: 'review',
    id: 'running',
    state: fromFacts('review', {
      cells: { review: { status: 'running' } },
      gateRuns: [caseGate({ id: 1, stageKey: 'review', gateName: 'lint (web)', exitCode: 0 })],
      processRuns: [reviewRun({ status: 'running', endedAt: null })],
    }),
  },
  {
    stage: 'review',
    id: 'passed',
    state: fromFacts('review', {
      cells: { review: { status: 'passed' } },
      gateRuns: [caseGate({ id: 1, stageKey: 'review', gateName: 'lint (web)', exitCode: 0 })],
      processRuns: [reviewRun()],
    }),
  },
  {
    stage: 'review',
    id: 'failed-blocking',
    state: fromFacts('review', {
      cells: { review: { status: 'failed' } },
      gateRuns: [caseGate({ id: 1, stageKey: 'review', gateName: 'lint (web)', exitCode: 0 })],
      processRuns: [reviewRun({ resultKind: 'findings' })],
      findings: BLOCKING,
    }),
  },
  {
    stage: 'review',
    id: 'multi-repo-filter',
    state: fromFacts('review', {
      cells: { review: { status: 'failed' } },
      processRuns: [reviewRun({ resultKind: 'findings' })],
      findings: MULTI_REPO,
      findingsRepoSelection: { review: CASE_WEB },
    }),
  },
  { stage: 'review', id: 'fix-running', state: fromFacts('review', loopFacts('review', 'live')) },
  { stage: 'review', id: 'passed-round-2', state: fromFacts('review', loopFacts('review', 'passed')) },
  {
    stage: 'review',
    id: 'older-round',
    state: fromFacts('review', loopFacts('review', 'passed', { attemptSelection: { review: 'sr:1' } })),
  },
  { stage: 'review', id: 'exhausted', state: fromFacts('review', exhaustedFacts('review')) },
  {
    stage: 'review',
    id: 'usage-limit',
    state: fromFacts('review', { cells: { review: { status: 'running' } }, processRuns: [reviewRun({ status: 'running', endedAt: null })] }, parkPatch(USAGE_PARK)),
  },

  // ship — HAND-WRITTEN rows from the legacy matrix; the preview cases alias the dashboard ones
  { stage: 'ship', id: 'pending', state: fromFacts('ship', { cells: { ship: { status: 'running' } } }) },
  { stage: 'ship', id: 'running', state: legacy('ship') },
  { stage: 'ship', id: 'passed', state: fromFacts('ship', { cells: { ship: { status: 'passed' } } }) },
  {
    stage: 'ship',
    id: 'deliver',
    state: legacy('ship', (s) => ({ ...s, deliver: { available: true, notOnPr: 2, inSandbox: 1 } })),
  },
  { stage: 'ship', id: 'preview-ready', aliasOf: 'confirm-ship', state: () => shipPreviewStateFor('ready') },
  { stage: 'ship', id: 'preview-blocked', aliasOf: 'ship-blocked', state: () => shipPreviewStateFor('blocked') },
  { stage: 'ship', id: 'preview-error', aliasOf: 'ship-error', state: () => shipPreviewStateFor('error') },
  {
    stage: 'ship',
    id: 'ci-failure',
    state: legacy('ship', (s) => ({ ...s, ciFailure: { available: true, repos: ['web'] } })),
  },

  // done — HAND-WRITTEN receipt (needs merged-PR + saga evidence rows)
  { stage: 'done', id: 'passed', state: legacy('done') },
  { stage: 'done', id: 'pending', state: fromFacts('done', {}) },
  { stage: 'done', id: 'running', state: fromFacts('done', { cells: { done: { status: 'running' } } }) },
  {
    stage: 'done',
    id: 'closed',
    state: legacy('done', (s) => ({ ...s, canClose: false, canReopen: true })),
  },
];
