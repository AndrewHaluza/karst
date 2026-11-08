import type { DashboardState } from './state.js';
import type { AutofixRowView } from '../../model/inside/autofix.js';
import type { InsideStageKey, InsideStageView } from '../../model/inside/types.js';
import type { StageKey } from '../../model/types.js';
import { buildStageRail } from '../../model/stageRail.js';
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
  /** A new dashboard route would add rows to the layout ledger, which only ever shrinks. */
  readonly skipLayout?: boolean;
  /** Baselines in dark, light and high contrast, not dark only (the amber and blue states must hold in every theme). */
  readonly allThemes?: boolean;
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

// ------------------------------------------------- auto-fix on the ship panel (T1004)

type AutopilotPatch = Partial<DashboardState['autopilot']>;

const AUTOFIX_STEPS_CONFLICT = ['agent resolving', 'running gates', 'karst delivers to PR', 're-probe'];
const AUTOFIX_STEPS_CI = ['host fetched log (gh)', 'agent fixing', 'gates', 'push', 'wait for CI'];

/**
 * HAND-WRITTEN: the legacy ship view with auto-fix state on its Merge row. `row` is the host-built view;
 * `banner` (with `reason`) parks the ticket the way the engine does (an awaiting-merge block). The cases skip the
 * layout ledger: it only ever shrinks, and these are new dashboard routes.
 */
function autofixShip(
  row: AutofixRowView | null,
  slice: AutopilotPatch,
  park?: { readonly reason: string },
): () => DashboardState {
  return legacy('ship', (s, v) => {
    const processes = v.processes.map((p) => {
      if (p.id !== 'merge' || !row) return p;
      const status = row.state === 'running' ? ('run' as const) : ('wait' as const);
      return { ...p, status, detail: row.message, autofix: row };
    });
    const cell = s.currentStage ?? caseCell('ship', 'running');
    return {
      ...s,
      autopilot: { override: 'inherit', projectDefault: true, effective: true, banner: null, log: [], ...slice },
      insideViews: { ...s.insideViews, ship: { ...v, processes } },
      currentStage: park
        ? { ...cell, blocked: { kind: 'awaiting-merge', reason: park.reason, at: t(30), resumable: false } }
        : cell,
    } as DashboardState;
  });
}

const RUNNING_CONFLICT: AutofixRowView = {
  state: 'running', message: 'Auto-fix: conflict on web #421 · round 1 of 2', steps: AUTOFIX_STEPS_CONFLICT, activeStep: 1, stopAfterRequested: false,
};
const RUNNING_CI: AutofixRowView = {
  state: 'running', message: 'Auto-fix: CI lint failed on api #88 · attempt 2 of 3', steps: AUTOFIX_STEPS_CI, activeStep: 1, stopAfterRequested: false,
};
const PARKED = { steps: [], activeStep: 0, stopAfterRequested: false };
const LOG = ['Autopilot: fixed lint on api #88', 'Autopilot: resolved conflicts on web #421'];

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
      services: [{ service: 'web', status: 'stopped', host: null, port: null, startedAt: null }],
    }),
  },
  {
    stage: 'uat',
    id: 'running',
    state: fromFacts('uat', {
      cells: { uat: { status: 'running' } },
      gateRuns: [caseGate({ id: 1, stageKey: 'uat', gateName: 'test (web)', exitCode: 0 })],
      processRuns: [uatTesterRun({ status: 'running', endedAt: null })],
      services: [{ service: 'web', status: 'running', host: 'localhost', port: 5173, startedAt: null }],
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
  {
    // T1041: a running tester run has no ledger row yet, so the pill states why.
    stage: 'uat',
    id: 'tokens-pending',
    skipLayout: true,
    state: fromFacts('uat', {
      cells: { uat: { status: 'running' } },
      gateRuns: [caseGate({ id: 1, stageKey: 'uat', gateName: 'test (web)', exitCode: 0 })],
      processRuns: [uatTesterRun({ status: 'running', endedAt: null })],
      tokensForRuns: () => ({ total: 0, pending: true }),
    }),
  },
  {
    // T1041: a finished run whose rows are all estimates shows the marked estimate.
    stage: 'uat',
    id: 'tokens-estimate',
    skipLayout: true,
    state: fromFacts('uat', {
      cells: { uat: { status: 'passed' } },
      gateRuns: [caseGate({ id: 1, stageKey: 'uat', gateName: 'test (web)', exitCode: 0 })],
      processRuns: [uatTesterRun()],
      tokensForRuns: () => ({ total: 0, cacheRead: 0, estimatedCalls: 2, estimatedTotal: 3700 }),
    }),
  },
  { stage: 'uat', id: 'fix-running', state: fromFacts('uat', loopFacts('uat', 'live')) },
  {
    // T938: round 2 is the recovery revalidation, so its gates carry the "why they re-ran" caption.
    stage: 'uat',
    id: 'gates-revalidation',
    skipLayout: true,
    state: fromFacts('uat', {
      ...loopFacts('uat', 'passed'),
      rounds: [caseRound({ id: 1, sourceStage: 'uat', round: 1, sourceStageRunId: 1, uatRevalidationStageRunId: 2, endedAt: t(30) })],
    }),
  },
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
        cells: { uat: { status: 'running', startedAt: t(20) } },
        services: [{ service: 'web', status: 'failed', host: null, port: null, reason: 'nothing listening on :5173 after 30s', startedAt: t(21) }],
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
    // T861: the Tester observed nothing — coverage SKIPPED, no observation.
    stage: 'uat',
    id: 'tester-skipped',
    skipLayout: true,
    state: fromFacts('uat', {
      cells: { uat: { status: 'passed' } },
      gateRuns: [caseGate({ id: 1, stageKey: 'uat', gateName: 'test (web)', exitCode: 0 })],
      processRuns: [uatTesterRun({ resultKind: 'skipped' })],
      findings: [caseFinding({ id: 4, severity: 'info', title: 'COVERAGE (reported): SKIPPED — uat:host probe not run; unit tests only', processRunId: 11 })],
    }),
  },
  {
    // T861: `onSkip: reask-then-park` parked UAT; the banner offers Re-run tester / Accept skip.
    stage: 'uat',
    id: 'tester-skipped-blocked',
    skipLayout: true,
    state: fromFacts(
      'uat',
      { cells: { uat: { status: 'running' } }, gateRuns: [caseGate({ id: 1, stageKey: 'uat', gateName: 'test (web)', exitCode: 0 })], processRuns: [uatTesterRun({ resultKind: 'skipped' })] },
      parkPatch({ kind: 'tester-skipped', reason: 'tester observed nothing — uat:host probe not run; unit tests only', at: t(25), resumable: false }),
    ),
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
  {
    // A failed ship offers Retry ship on the stage rail (same needs-you segment as Confirm ship).
    stage: 'ship',
    id: 'failed',
    // Same rail segment markup as Confirm ship: adds no layout of its own, so it stays out of the ledger.
    skipLayout: true,
    state: fromFacts('ship', { cells: { ship: { status: 'failed' } } }, (s) => ({
      ...s,
      rail: buildStageRail(s.stepper, s.stepper, {
        current: 'ship',
        needsUser: true,
        needs: { detail: 'describe step failed for web', action: 'Retry ship', cta: { kind: 'retry-ship' } },
      }),
    })),
  },
  { stage: 'ship', id: 'passed', state: fromFacts('ship', { cells: { ship: { status: 'passed' } } }) },
  {
    stage: 'ship',
    id: 'deliver',
    state: legacy('ship', (s) => ({ ...s, deliver: { available: true, notOnPr: 2, inSandbox: 1 } })),
  },
  {
    stage: 'ship',
    id: 'deliver-auto-running',
    skipLayout: true,
    state: legacy('ship', (s) => ({ ...s, deliver: { available: true, notOnPr: 2, inSandbox: 0, auto: { running: { n: 3, m: 5, gate: 'integration-sandbox-docker-layout-visual-regression-gate' }, failures: [], takenOver: null, roundActive: true, headSha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678' } } })),
  },
  {
    stage: 'ship',
    id: 'deliver-auto-failed',
    skipLayout: true,
    state: legacy('ship', (s) => ({ ...s, deliver: { available: true, notOnPr: 2, inSandbox: 0, auto: { running: { n: 4, m: 5, gate: 'visual' }, failures: [{ gate: 'integration-sandbox-docker-layout-visual-regression-gate', repo: 'karst', exitCode: 1, headSha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678', summary: 'Error: expected 3 results but received 2 while comparing the very-long-recorded-baseline-name-for-the-dashboard-view.png' }], takenOver: null, roundActive: true, headSha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678' } } })),
  },
  {
    stage: 'ship',
    id: 'deliver-auto-taken-over',
    skipLayout: true,
    state: legacy('ship', (s) => ({ ...s, deliver: { available: true, notOnPr: 2, inSandbox: 0, auto: { running: null, failures: [{ gate: 'integration-sandbox-docker-layout-visual-regression-gate', repo: 'karst', exitCode: 1, headSha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678', summary: 'Error: expected 3 results but received 2 while comparing the very-long-recorded-baseline-name-for-the-dashboard-view.png' }], takenOver: { failed: ['integration-sandbox-docker-layout-visual-regression-gate'], skipped: ['visual', 'docs-graph'] }, roundActive: false, headSha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678' } } })),
  },
  {
    stage: 'ship',
    id: 'deliver-auto-older-head',
    skipLayout: true,
    state: legacy('ship', (s) => ({ ...s, deliver: { available: true, notOnPr: 2, inSandbox: 0, auto: { running: null, failures: [{ gate: 'integration-sandbox-docker-layout-visual-regression-gate', repo: 'karst', exitCode: 1, headSha: '0f9e8d7c6b5a49382716f5e4d3c2b1a099887766', summary: 'Error: expected 3 results but received 2 while comparing the very-long-recorded-baseline-name-for-the-dashboard-view.png' }], takenOver: null, roundActive: false, headSha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678' } } })),
  },
  { stage: 'ship', id: 'preview-ready', aliasOf: 'confirm-ship', state: () => shipPreviewStateFor('ready') },
  { stage: 'ship', id: 'preview-blocked', aliasOf: 'ship-blocked', state: () => shipPreviewStateFor('blocked') },
  { stage: 'ship', id: 'preview-error', aliasOf: 'ship-error', state: () => shipPreviewStateFor('error') },
  {
    stage: 'ship',
    id: 'ci-failure',
    state: legacy('ship', (s) => ({ ...s, ciFailure: { available: true, repos: ['web'] } })),
  },

  // auto-fix on the Merge row and the blocked banner (T1004): HAND-WRITTEN, outside the layout ledger
  { stage: 'ship', id: 'auto-conflict-running', skipLayout: true, allThemes: true, state: autofixShip(RUNNING_CONFLICT, { log: LOG }) },
  { stage: 'ship', id: 'auto-ci-running', skipLayout: true, allThemes: true, state: autofixShip(RUNNING_CI, { override: 'on', log: LOG }) },
  {
    stage: 'ship',
    id: 'auto-budget-spent',
    skipLayout: true,
    allThemes: true,
    state: autofixShip(
      { ...PARKED, state: 'spent', message: 'Auto-fix stopped: CI failed 3 of 3 attempts on api #88' },
      {
        banner: {
          state: 'spent', title: 'lint', titleHref: 'https://github.com/example/api/actions/runs/1', titleSuffix: 'failed on api #88',
          cause: 'Auto-fix tried 3 of 3 times and the check still fails.',
          primary: { act: 'autopilot-approve-one', label: 'Approve 1 more attempt', repo: 'api', kind: 'ci' },
          secondary: { act: 'send-ci-failure', label: 'Send CI failure with a note…' },
          history: ['Attempt 1 · lint · 09:10', 'Attempt 2 · lint · 09:20', 'Attempt 3 · lint · 09:31'],
        },
        log: LOG,
      },
      { reason: 'auto-fix stopped: ci 3/3' },
    ),
  },
  {
    stage: 'ship',
    id: 'auto-gh-failed',
    skipLayout: true,
    allThemes: true,
    state: autofixShip(
      { ...PARKED, state: 'gh-failed', message: 'Auto-fix paused: could not read CI for api #88 (gh: HTTP 502)' },
      {
        banner: {
          state: 'gh-failed', title: 'Auto-fix paused', titleSuffix: 'could not read CI', cause: 'Could not read CI for api #88 (gh: HTTP 502)',
          primary: { act: 'autopilot-retry', label: 'Retry' }, secondary: null, history: [],
        },
      },
      { reason: 'auto-fix paused: could not read CI for api #88 (gh: HTTP 502)' },
    ),
  },
  {
    stage: 'ship',
    id: 'auto-status-unknown',
    skipLayout: true,
    allThemes: true,
    state: autofixShip({ ...PARKED, state: 'unknown', message: 'CI status unknown for api #88. Auto-fix waits; not counted as pass.' }, {}),
  },
  {
    stage: 'ship',
    id: 'auto-override-off',
    skipLayout: true,
    allThemes: true,
    state: autofixShip(null, { override: 'off', effective: false }),
  },
  {
    stage: 'ship',
    id: 'auto-sandbox-paused',
    skipLayout: true,
    allThemes: true,
    state: autofixShip(
      { ...PARKED, state: 'paused', message: 'Auto-fix paused: sandbox clone is dirty' },
      {
        banner: {
          state: 'paused', title: 'Auto-fix paused', titleSuffix: 'sandbox ticket',
          cause: 'The sandbox cannot run a round. Fix the sandbox, then retry.',
          primary: { act: 'autopilot-retry', label: 'Retry' }, secondary: { act: 'sandbox-diff', label: 'Open sync diff' }, history: [],
        },
      },
      { reason: 'auto-fix paused: sandbox clone is dirty' },
    ),
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
