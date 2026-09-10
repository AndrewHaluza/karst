/**
 * Per-view state corpora for the visual sweep's fixture pages.
 *
 * Each entry provides the postMessage payload that seeds the webview's
 * initial render.  Dashboard uses its real renderFixtures corpus; every
 * other view uses a MINIMAL empty/initial state — the smallest payload
 * that the webview's own render function can handle without crashing.
 *
 * `MINIMAL_RATCHET` tracks which views are still on the MINIMAL seed.
 * When FEAT-37 delivers per-view fixture corpora, each view is replaced
 * by a one-line edit and removed from the ratchet.  The ratchet is
 * shrink-only: its size must never grow.
 */
import {
  renderFixtures,
  type RenderScenario,
  type RenderRepoCount,
} from '../../src/ui/dashboard/renderFixtures.js';
import type { DashboardState } from '../../src/ui/dashboard/state.js';
import type { WebviewName } from '../../src/model/webviewChains.js';

export type ViewId = WebviewName;

export interface ViewCorpus {
  readonly messages: readonly unknown[];
}

/**
 * Dashboard: the 10-repository row, all six scenarios.
 * 10 repos exercises the bounded "+N more" remainder rows (the limit is 6
 * for worktree/gate/repo evidence, 8 for worktrees).  Six scenarios cover
 * every stage view.
 */
function dashboardCorpus(): ViewCorpus {
  const scenarios: RenderScenario[] = [
    'pending',
    'running',
    'passed',
    'failed',
    'waiting',
    'exhausted',
  ];
  const repoCount: RenderRepoCount = 10;
  const fixtures = renderFixtures().filter(
    (f) => f.repositoryCount === repoCount && scenarios.includes(f.scenario),
  );
  // The dashboard receives a single { type: 'state', state } message per view.
  // For the sweep, we send one message per scenario as separate fixture pages.
  // Here we return the pending scenario as the default seed; the fixture builder
  // iterates over all six scenarios.
  const pending = fixtures.find((f) => f.scenario === 'pending');
  if (!pending) throw new Error('pending fixture not found');
  return {
    messages: [{ type: 'state', state: { insideViews: { pending: pending.view } } }],
  };
}

/** Dashboard: all six scenarios for the 10-repository row. */
export function dashboardCorpora(): readonly {
  scenario: RenderScenario;
  corpus: ViewCorpus;
}[] {
  const scenarios: RenderScenario[] = [
    'pending',
    'running',
    'passed',
    'failed',
    'waiting',
    'exhausted',
  ];
  const repoCount: RenderRepoCount = 10;
  const fixtures = renderFixtures().filter(
    (f) => f.repositoryCount === repoCount && scenarios.includes(f.scenario),
  );
  return fixtures.map((f) => ({
    scenario: f.scenario,
    corpus: {
      messages: [{ type: 'state', state: { insideViews: { [f.stage]: f.view } } }],
    },
  }));
}

/**
 * MINIMAL state for each non-dashboard view — the smallest payload that
 * the webview's render function handles without crashing.  Lifted from
 * the render harness smoke test (renderHarness.render.test.ts) and the
 * per-view webview.test.ts files.
 *
 * These will be replaced by real corpora when FEAT-37 lands.
 */

const MINIMAL_USAGE = {
  empty: true,
  rangeId: '',
  ranges: [],
  sort: 'total',
  sorts: [],
  totals: { total: 0, input: 0, output: 0 },
  byStage: [],
  byModel: [],
  byProfile: [],
  tickets: [],
  page: { offset: 0, limit: 0, groups: 0, hasPrev: false, hasNext: false },
  error: null,
};

const MINIMAL_RESOURCES = {
  supported: false,
  degraded: false,
  totals: { rssBytes: 0, cpuPct: null },
  rssDisplay: '',
  cpuPctDisplay: '',
  rows: [],
  unknown: [],
  waste: [],
  history: [],
  disk: [],
  sampleAgeDisplay: '',
  scopeLabel: '',
  wasteCount: 0,
  attributedRoots: 0,
  unattributedShown: 0,
  trend: { cpuMaxDisplay: '', rssMaxDisplay: '', timeTicks: [], yTicks: [] },
};

const MINIMAL_SIDEBAR = {
  facets: ['all'],
  filter: '',
  counts: { all: 0, active: 0, paused: 0, blocked: 0, done: 0, archived: 0 },
  sections: { current: [], recentlyDone: [], olderDone: [] },
  done: [],
  rows: [],
};

const MINIMAL_DIFFS = {
  worktrees: [],
  commitCount: 0,
  pendingCount: 0,
};

const MINIMAL_SETTINGS = {
  manifest: {
    repositories: [],
    agent: { provider: null, model: null },
    agents: {},
  },
  error: null,
  installedIds: [],
  tokenConfigured: false,
  implementedProviders: [],
  agents: [],
  approachCommands: {},
  models: {},
  modelCompatibility: {},
  recentModels: {},
  processAssignments: [],
  manifestPath: '',
  bundledApproaches: [],
  currentSection: 'general',
};

const MINIMAL_TICKET_FORM = {
  mode: 'create',
  key: '',
  title: '',
  description: '',
  sourceRef: '',
  brief: null,
  provider: 'manual',
  ticketSearchEnabled: false,
  canCreateProviderTicket: false,
  repos: [],
  type: null,
  typeOptions: [],
  approach: null,
  approaches: [],
  agent: null,
  model: null,
  models: {},
  effort: null,
  ticketUrl: null,
  parent: null,
};

const MINIMAL_GETTING_STARTED = {
  checklist: [],
  tutorial: [],
};

/** The per-view MINIMAL corpus. */
const MINIMAL_CORPORA: Record<ViewId, ViewCorpus> = {
  dashboard: dashboardCorpus(),
  usage: { messages: [{ type: 'state', state: MINIMAL_USAGE }] },
  resources: { messages: [{ type: 'state', state: MINIMAL_RESOURCES }] },
  sidebar: { messages: [{ type: 'state', state: MINIMAL_SIDEBAR }] },
  diffs: { messages: [{ type: 'state', state: MINIMAL_DIFFS }] },
  settings: { messages: [{ type: 'state', state: MINIMAL_SETTINGS }] },
  ticketForm: { messages: [{ type: 'state', state: MINIMAL_TICKET_FORM }] },
  gettingStarted: { messages: [{ type: 'state', state: MINIMAL_GETTING_STARTED }] },
};

export function getCorpus(view: ViewId): ViewCorpus {
  return MINIMAL_CORPORA[view]!;
}

/**
 * Views still on the MINIMAL seed.  Shrink-only: removing a view here is
 * a one-line edit when FEAT-37 delivers its corpus; adding a view is a
 * regression.
 *
 * Dashboard is excluded — its corpus exists today.
 */
export const MINIMAL_RATCHET: readonly ViewId[] = [
  'usage',
  'resources',
  'sidebar',
  'diffs',
  'settings',
  'ticketForm',
  'gettingStarted',
];

/** All eight view ids. */
export const ALL_VIEWS: readonly ViewId[] = [
  'dashboard',
  'usage',
  'resources',
  'sidebar',
  'diffs',
  'settings',
  'ticketForm',
  'gettingStarted',
];
