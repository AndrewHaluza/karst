import type { DashboardState } from './state.js';
import type {
  EvidenceRow,
  InsideStageKey,
  InsideStageView,
  InsideDot,
  StageInside,
  TokenUsageView,
  TypedInsideAction,
} from '../../model/inside/types.js';
import { STAGE_BLURBS, STAGE_TITLES } from '../../model/inside/types.js';
import { boundedEvidenceRows } from '../../model/inside/bounds.js';
import { REPOSITORY_EVIDENCE_LIMIT } from '../../model/inside/ship.js';
import type { StageKey } from '../../model/types.js';
import { STAGE_KEYS } from '../../model/types.js';

/**
 * The checked-in render fixture matrix for the dashboard webview's render
 * tests (the reworked successors of the removed development harness's
 * fixtures — same data, no harness).
 *
 * A deterministic `InsideStageView` per (repository count × scenario) pair —
 * 2/5/10/15/20 repositories, each in one of six scenarios (pending, running,
 * passed, failed, waiting, exhausted). The matrix is built ONLY from the
 * production presentation shapes (`InsideStageView`, `InsideProcessView`,
 * `EvidenceRow`, `TokenUsageView`, `AgentExecutionView`, `TypedInsideAction`)
 * and is pure data: no SQLite reads, no real worktrees, no executable action
 * targets — every action id is `fixture:`-prefixed, which the host's
 * `InsideActionRegistry` (which mints `snapshot-<n>:…` ids) can never resolve,
 * so no fixture control can ever dispatch a real target.
 *
 * Only evidence ROWS scale with the repository count. The process roster of a
 * stage is constant — the six-stage contract (`INSIDE_PROCESSES`) — and the
 * bounded remainder rows ("+N more") reproduce the production reducers' own
 * bounds (worktrees 8, gates 8, ship per-repo processes 6), so a render test
 * sees exactly what a real ticket of that size renders.
 *
 * The matrix deliberately carries long, hostile, untrusted labels and paths
 * (`<script>`, `&`, `"`) so the render tests exercise the renderer's escaping.
 */

/** The repository counts the matrix covers. */
export type RenderRepoCount = 2 | 5 | 10 | 15 | 20;

/** The six lifecycle scenarios every repo count is rendered in. */
export type RenderScenario = 'pending' | 'running' | 'passed' | 'failed' | 'waiting' | 'exhausted';

/** Ordered vocabularies — deterministic iteration is part of the contract. */
export const RENDER_REPO_COUNTS: readonly RenderRepoCount[] = [2, 5, 10, 15, 20];
export const RENDER_SCENARIOS: readonly RenderScenario[] = [
  'pending',
  'running',
  'passed',
  'failed',
  'waiting',
  'exhausted',
];

/** One checked-in fixture: a full stage view plus its matrix identity. */
export interface InsideRenderFixture {
  repositoryCount: RenderRepoCount;
  stage: InsideStageKey;
  scenario: RenderScenario;
  view: InsideStageView;
}

/** Stable synthetic repository names, in matrix order. */
const REPO_NAMES = [
  'web',
  'api',
  'worker',
  'jobs',
  'search',
  'notify',
  'assets',
  'console',
  'catalog',
  'billing',
  'auth',
  'gateway',
  'edge',
  'batch',
  'metrics',
  'reports',
  'cache',
  'queue',
  'sync',
  'export',
] as const;

/** The scenario each fixture stage renders on — one canonical stage per scenario. */
const STAGE_FOR_SCENARIO: Readonly<Record<RenderScenario, InsideStageKey>> = {
  pending: 'scope',
  running: 'impl',
  passed: 'done',
  failed: 'review',
  waiting: 'ship',
  exhausted: 'uat',
};

/** The bounds the production reducers apply (see the module doc). */
const WORKTREES_LIMIT = 8;
const GATES_LIMIT = 8;
const REPO_ROWS_LIMIT = 6;
const TIMELINE_LIMIT = 20;
const FINDINGS_LIMIT = 6;

/** Bound rows the way the production reducers do, appending the "+N more" marker. */
function boundedRows(
  rows: readonly EvidenceRow[],
  limit: number,
  actionable = false,
): EvidenceRow[] {
  return boundedEvidenceRows(
    rows,
    limit,
    actionable ? () => fixtureAction('open-bounded-evidence', rows.length) : undefined,
  );
}

/** The first `n` repo names, in matrix order. */
function repoNames(n: RenderRepoCount): readonly string[] {
  return REPO_NAMES.slice(0, n);
}

const CLAUDE_EXECUTION = {
  provider: 'claude',
  providerLabel: 'Claude Code',
  model: 'claude-opus-4-1',
  modelLabel: 'Claude Opus 4.1',
} as const;

const CODEX_EXECUTION = {
  provider: 'codex',
  providerLabel: 'Codex',
  model: 'codex-x',
  modelLabel: 'Codex X',
} as const;

/** A measured token display — never an estimate in this matrix. */
const MEASURED_TOKENS: TokenUsageView = {
  state: 'measured',
  total: '12.4k',
  exact: '12,435',
};

const ESTIMATED_TOKENS: TokenUsageView = {
  state: 'estimated',
  total: '3.1k',
  exact: '3,098',
};

/** A deep, long file path with no scale match in the data layer. */
const LONG_PATH =
  'src/services/fulfillment/orchestrator/checkout-engine/src/main/java/com/platform/fulfillment/checkout/CheckoutFulfillmentOrchestratorServiceImplFactoryProviderConfigurationBuilder.java';

/** An inert, un-resolvable capability — see the module doc. */
function fixtureAction(kind: TypedInsideAction['kind'], n: number): TypedInsideAction {
  return { actionId: `fixture:${kind}:${n}`, kind };
}

/** One hostile finding title — must survive the matrix so escaping has teeth. */
const HOSTILE_TITLE =
  `Unescaped & untrusted <script>alert('xss')</script> title "quoted"`;

/** The scope stage: the hot set + one worktree row per repo, all pending. */
function scopeView(n: RenderRepoCount): InsideStageView {
  const rows = boundedRows(
    repoNames(n).map(
      (r): EvidenceRow => ({ status: 'pending', label: 'worktree', detail: r }),
    ),
    WORKTREES_LIMIT,
  );
  return {
    stageKey: 'scope',
    title: 'Scope',
    dot: 'pend',
    clock: 'has not run yet',
    processes: [
      {
        id: 'hot-set',
        kind: 'hot-set',
        label: 'Hot set',
        status: 'pending',
        count: String(n),
        detail: `${n} services to validate against the manifest`,
      },
      {
        id: 'worktrees',
        kind: 'worktrees',
        label: 'Worktrees',
        status: 'pending',
        evidence: { kind: 'rows', rows },
      },
    ],
    blurb: STAGE_BLURBS.scope,
  };
}

/** The impl stage: the live session timeline (the "live" state). */
function implView(_n: RenderRepoCount): InsideStageView {
  const rows: EvidenceRow[] = [
    { status: 'note', label: 'started', detail: '09:12:33', duration: '4m 12s' },
    {
      status: 'note',
      label: 'switch',
      detail: 'Codex · Codex X',
      connector: 'switch',
    },
    {
      status: 'note',
      label: 'resumed',
      detail: 'Claude Code · Claude Opus 4.1',
      connector: 'resume',
    },
    { status: 'note', label: 'research', detail: '09:41:02' },
    { status: 'note', label: 'plan', detail: '09:44:51' },
  ];
  return {
    stageKey: 'impl',
    title: 'Implementation',
    dot: 'run',
    clock: 'started 09:12:33 · 4m 12s elapsed · attempt 1',
    processes: [
      {
        id: 'session',
        kind: 'session',
        label: 'Session',
        status: 'run',
        detail: 'session k-9f2e — claude-opus-4-1',
        duration: '4m 12s',
        execution: { ...CLAUDE_EXECUTION },
        tokens: { ...MEASURED_TOKENS },
        action: fixtureAction('open-full-evidence', 1),
        evidence: { kind: 'timeline', rows: boundedRows(rows, TIMELINE_LIMIT) },
      },
    ],
    blurb: STAGE_BLURBS.impl,
  };
}

/** The done stage: the delivery receipt with every current PR merged. */
function doneView(n: RenderRepoCount): InsideStageView {
  const rows: EvidenceRow[] = [
    ...boundedRows(
      repoNames(n).map(
        (r, i): EvidenceRow => ({ status: 'pass', label: 'merged', detail: `${r} #${110 + i}` }),
      ),
      REPOSITORY_EVIDENCE_LIMIT,
      true,
    ),
    { status: 'note', label: 'commits', detail: '31 created by ship' },
    { status: 'note', label: 'validated', detail: '14 gates passed on the final run' },
    { status: 'note', label: 'recovery', detail: '1 round fixed before delivery' },
  ];
  return {
    stageKey: 'done',
    title: 'Done',
    dot: 'done',
    clock: '09:58:44 · 3m 02s',
    processes: [
      {
        id: 'delivery-receipt',
        kind: 'delivery-receipt',
        label: 'Delivery receipt',
        status: 'pass',
        detail: '38.2k tokens recorded',
        tokens: { ...ESTIMATED_TOKENS },
        evidence: { kind: 'receipt', rows },
      },
    ],
    blurb: STAGE_BLURBS.done,
  };
}

/** The review stage: gates failed, blocking findings (the "error" state). */
function reviewView(n: RenderRepoCount): InsideStageView {
  const gateRows: EvidenceRow[] = [
    ...repoNames(n).flatMap(
      (r, i): EvidenceRow[] => [
        { status: 'pass', label: 'lint', detail: 'exit 0' },
        {
          status: i === 0 ? 'fail' : 'pass',
          label: 'test',
          detail: i === 0 ? 'exit 1' : 'exit 0',
        },
      ],
    ),
    { status: 'skip', label: 'smoke', detail: 'Skipped — disabled by user' },
  ];
  const findings: EvidenceRow[] = [
    {
      status: 'fail',
      label: 'critical',
      detail: `${HOSTILE_TITLE} — ${LONG_PATH}`,
      action: fixtureAction('open-file', 1),
    },
    {
      status: 'fail',
      label: 'high',
      detail: 'SQL injection in query builder — src/db/query.ts:41',
      action: fixtureAction('open-file', 2),
    },
    {
      status: 'note',
      label: 'medium',
      detail: 'N+1 query in ticket list — src/store/tickets.ts:88',
      action: fixtureAction('open-file', 3),
    },
  ];
  return {
    stageKey: 'review',
    title: 'Review',
    dot: 'fail',
    clock: '09:20:11 · 3m 02s · attempt 2',
    processes: [
      {
        id: 'gates',
        kind: 'gates',
        label: 'Gates',
        status: 'fail',
        evidence: {
          kind: 'gates',
          rows: boundedRows(gateRows, GATES_LIMIT),
          passed: 2 * n - 1,
          failed: 1,
          skipped: 1,
        },
      },
      {
        id: 'services',
        kind: 'services',
        label: 'Services',
        status: 'note',
        detail: repoNames(n).join(' · '),
      },
      {
        id: 'review',
        kind: 'review',
        label: 'Review',
        status: 'fail',
        detail: '2 blocking findings',
        duration: '2m 10s',
        execution: { ...CODEX_EXECUTION },
        tokens: { ...MEASURED_TOKENS },
        evidence: { kind: 'findings', rows: boundedRows(findings, FINDINGS_LIMIT), blocking: 2 },
      },
    ],
    blurb: STAGE_BLURBS.review,
  };
}

/** The ship stage: everything landed except the merge — waiting on PRs. */
function shipView(n: RenderRepoCount): InsideStageView {
  const commitRows = repoNames(n).map(
    (r): EvidenceRow => ({ status: 'pass', label: r, detail: '2 created · 1 before' }),
  );
  const pushRows = repoNames(n).map(
    (r): EvidenceRow => ({ status: 'pass', label: r, detail: 'pushed' }),
  );
  const prRows = repoNames(n).map(
    (r, i): EvidenceRow => ({ status: 'pass', label: r, detail: `created #${120 + i}` }),
  );
  const mergeRows = repoNames(n).map(
    (r, i): EvidenceRow => ({
      status: 'wait',
      label: 'open',
      detail: `${r} #${120 + i} · not merged yet`,
    }),
  );
  return {
    stageKey: 'ship',
    title: 'Ship',
    dot: 'wait',
    clock: '09:40:02 · 1m 40s · attempt 1',
    processes: [
      {
        id: 'commit',
        kind: 'commit',
        label: 'Commit',
        status: 'pass',
        evidence: {
          kind: 'commits',
          rows: boundedRows(commitRows, REPO_ROWS_LIMIT, true),
          total: 2 * n,
        },
      },
      {
        id: 'push',
        kind: 'push',
        label: 'Push',
        status: 'pass',
        evidence: { kind: 'rows', rows: boundedRows(pushRows, REPO_ROWS_LIMIT, true) },
      },
      {
        id: 'pr',
        kind: 'pr',
        label: 'Pull request',
        status: 'pass',
        evidence: {
          kind: 'prs',
          rows: boundedRows(prRows, REPO_ROWS_LIMIT, true),
          open: n,
          merged: 0,
        },
      },
      {
        id: 'merge',
        kind: 'merge',
        label: 'Merge',
        status: 'wait',
        evidence: { kind: 'rows', rows: boundedRows(mergeRows, REPOSITORY_EVIDENCE_LIMIT, true) },
      },
    ],
    blurb: STAGE_BLURBS.ship,
  };
}

/** The uat stage: gates passed, tester failed, fix rounds exhausted. */
function uatView(n: RenderRepoCount): InsideStageView {
  const gateRows = repoNames(n).flatMap(
    (r): EvidenceRow[] => [
      { status: 'pass', label: 'lint', detail: 'exit 0' },
      { status: 'pass', label: 'test', detail: 'exit 0' },
    ],
  );
  const observations: EvidenceRow[] = [
    {
      status: 'note',
      label: 'warning',
      detail: `flaky timeout in auth flow — ${LONG_PATH}:19`,
      action: fixtureAction('open-file', 4),
    },
    {
      status: 'note',
      label: 'info',
      detail: 'deprecated fetch API — src/http/client.ts:8',
      action: fixtureAction('open-file', 5),
    },
  ];
  return {
    stageKey: 'uat',
    title: 'UAT',
    dot: 'fail',
    clock: '10:03:55 · 41.2s · attempt 3',
    processes: [
      {
        id: 'gates',
        kind: 'gates',
        label: 'Gates',
        status: 'pass',
        evidence: {
          kind: 'gates',
          rows: boundedRows(gateRows, GATES_LIMIT),
          passed: 2 * n,
          failed: 0,
          skipped: 0,
        },
      },
      {
        id: 'services',
        kind: 'services',
        label: 'Services',
        status: 'note',
        detail: repoNames(n).join(' · '),
      },
      {
        id: 'tester',
        kind: 'tester',
        label: 'Tester',
        status: 'fail',
        detail: 'verifier failed — the observation did not hold',
        duration: '38.4s',
        execution: { ...CODEX_EXECUTION },
        tokens: { ...ESTIMATED_TOKENS },
        evidence: { kind: 'rows', rows: observations },
      },
      {
        id: 'fix',
        kind: 'fix',
        label: 'Fix',
        status: 'fail',
        detail: 'no fix attempts left',
        duration: '2m 31s',
        execution: { ...CLAUDE_EXECUTION },
        evidence: {
          kind: 'recovery',
          rows: [
            { status: 'pass', label: 'round 1', detail: 'gate test failed — max 3' },
            { status: 'fail', label: 'round 2', detail: 'observation did not hold — max 3' },
            {
              status: 'fail',
              label: 'round 3',
              detail: 'observation did not hold — max 3 — no fix attempts left',
            },
          ],
        },
      },
    ],
    blurb: STAGE_BLURBS.uat,
  };
}

/** One stage view per (repo count, scenario) pair, in matrix order. */
function buildView(stage: InsideStageKey, n: RenderRepoCount): InsideStageView {
  switch (stage) {
    case 'scope':
      return scopeView(n);
    case 'impl':
      return implView(n);
    case 'uat':
      return uatView(n);
    case 'review':
      return reviewView(n);
    case 'ship':
      return shipView(n);
    case 'done':
      return doneView(n);
  }
}

/**
 * The full deterministic matrix: every repo count × every scenario, ordered
 * by repo count then scenario. Pure data — callable any number of times with
 * identical results.
 */
export function renderFixtures(): readonly InsideRenderFixture[] {
  return RENDER_REPO_COUNTS.flatMap((n) =>
    RENDER_SCENARIOS.map((scenario) => {
      const stage = STAGE_FOR_SCENARIO[scenario];
      return {
        repositoryCount: n,
        stage,
        scenario,
        view: buildView(stage, n),
      };
    }),
  );
}

/** The six inside stage keys, in presentation order. */
const INSIDE_STAGE_KEYS: readonly InsideStageKey[] = [
  'scope',
  'impl',
  'uat',
  'review',
  'ship',
  'done',
];

/** The default matrix row for one stage — the first (smallest) repo count. */
function defaultViewFor(stage: InsideStageKey): InsideStageView {
  const fixture = renderFixtures().find((f) => f.stage === stage);
  if (!fixture) throw new Error(`no render fixture for stage ${stage}`);
  return fixture.view;
}

/** An empty, renderable view for a stage the matrix does not cover. */
function emptyStageView(key: InsideStageKey): InsideStageView {
  return {
    stageKey: key,
    title: STAGE_TITLES[key],
    dot: 'pend' as InsideDot,
    clock: 'has not run yet',
    processes: [],
    blurb: STAGE_BLURBS[key],
  };
}

/** An empty legacy-strip shell for every runtime stage the webview may render. */
function emptyStageInside(): Record<StageKey, StageInside> {
  const out = {} as Record<StageKey, StageInside>;
  for (const key of STAGE_KEYS) {
    out[key] = {
      stageKey: key,
      title: STAGE_TITLES[key],
      dot: 'pend' as InsideDot,
      clock: '',
      ops: [],
      blurb: STAGE_BLURBS[key],
    };
  }
  return out;
}

/**
 * Wrap one stage's default matrix view in the dashboard snapshot envelope the
 * webview's render functions consume. Everything outside `insideViews` is
 * neutral: an empty rail, no stepper, no servers, no worktrees, no PRs — the
 * render tests exercise the Inside component and nothing else. `ticketId` 0 is
 * a placeholder: the envelope never queries the store, and the webview only
 * posts ids back for actions the fixtures cannot dispatch (`fixture:` ids
 * resolve nowhere).
 */
export function renderStateFor(stage: InsideStageKey): DashboardState {
  const insideViews = {} as Record<InsideStageKey, InsideStageView>;
  for (const key of INSIDE_STAGE_KEYS) {
    insideViews[key] = key === stage ? defaultViewFor(stage) : emptyStageView(key);
  }
  return {
    ticketId: 0,
    key: null,
    title: null,
    stageCurrent: stage,
    agentState: null,
    agentSession: {
      provider: 'claude',
      providerLabel: 'Claude Code',
      modelId: null,
      modelLabel: 'Agent default',
      canSwitch: false,
    },
    stepper: [],
    currentStage: null,
    now: { text: 'Render fixture' },
    servers: [],
    hasRunnableRepos: false,
    worktrees: [],
    prs: [],
    mergeChecks: [],
    provider: null,
    sourceRef: null,
    ticketUrl: null,
    brief: null,
    rail: { main: [] },
    inside: emptyStageInside(),
    insideViews,
    presentedStage: stage,
    approach: null,
  };
}
