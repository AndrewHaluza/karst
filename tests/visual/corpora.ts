/**
 * Per-view state corpora for the visual sweep's fixture pages.
 *
 * Each entry provides the postMessage payload that seeds the webview's
 * initial render.  Six views (dashboard, sidebar, usage, resources,
 * gettingStarted, diffs) seed from the checked-in renderFixtures corpus
 * their own render tests use; serverLogs seeds through its own protocol.
 * The remaining two use a MINIMAL empty/initial state — the smallest
 * payload that the webview's own render function can handle without
 * crashing.
 *
 * `MINIMAL_RATCHET` tracks which views are still on the MINIMAL seed.
 * When FEAT-37 delivers per-view fixture corpora, each view is replaced
 * by a one-line edit and removed from the ratchet.  The ratchet is
 * shrink-only: its size must never grow.
 */
import {
  renderFixtures,
  populatedStateFor,
  type RenderScenario,
  type RenderRepoCount,
} from '../../src/ui/dashboard/renderFixtures.js';
import { sidebarRenderFixtures } from '../../src/ui/sidebar/renderFixtures.js';
import { usageRenderFixtures } from '../../src/ui/usage/renderFixtures.js';
import { resourcesRenderFixtures } from '../../src/ui/resources/renderFixtures.js';
import { gettingStartedRenderFixtures } from '../../src/ui/gettingStarted/renderFixtures.js';
import { diffsRenderFixtures } from '../../src/ui/diffs/renderFixtures.js';
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
 *
 * The message is a FULL `DashboardState` — `populatedStateFor(f.stage)`'s
 * populated envelope (header key/title, stepper, rail, servers, worktrees,
 * PRs) with that scenario's `f.view` substituted into `insideViews[f.stage]`
 * — not a bare `{ insideViews }` partial. A partial rendered a header reading
 * "#undefined (untitled)" over three empty panels, which pinned nothing
 * about the most important view in the product.
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
  const state = populatedStateFor(pending.stage);
  return {
    messages: [
      {
        type: 'state',
        state: { ...state, insideViews: { ...state.insideViews, [pending.stage]: pending.view } },
      },
    ],
  };
}

/**
 * Dashboard: all six scenarios for the 10-repository row.
 *
 * Each scenario's message is a full populated `DashboardState`
 * (`populatedStateFor(f.stage)`) with `f.view` substituted into
 * `insideViews[f.stage]` — see `dashboardCorpus` above for why a bare
 * `{ insideViews }` partial is not enough.
 */
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
  return fixtures.map((f) => {
    const state = populatedStateFor(f.stage);
    return {
      scenario: f.scenario,
      corpus: {
        messages: [
          {
            type: 'state',
            state: { ...state, insideViews: { ...state.insideViews, [f.stage]: f.view } },
          },
        ],
      },
    };
  });
}

/**
 * MINIMAL state for the two views with no renderFixtures module — the
 * smallest payload their render function handles without crashing.  Lifted
 * from the render harness smoke test (renderHarness.render.test.ts) and the
 * per-view webview.test.ts files.
 *
 * These are what is left of FEAT-37. Unlike the six views already converted,
 * a corpus here cannot be a reuse: it has to be authored, and authored state
 * that no other test pins is state that can quietly stop resembling the real
 * thing.  Writing the renderFixtures module first is the cheaper order.
 */
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


/**
 * The standalone server-logs panel does NOT speak the generic `state` message —
 * it answers `server-logs-request` with a `server-logs` snapshot of its own.  So
 * this is a real protocol corpus (not the MINIMAL seed), which is why the view
 * is deliberately absent from MINIMAL_RATCHET below (that ratchet asserts its
 * members are `state`-seeded).  The content carries a run marker, ISO
 * timestamps and SGR runs so the baseline pins the decoder's rendering.
 */
const SERVER_LOGS_CORPUS: ViewCorpus = {
  messages: [
    {
      type: 'server-logs',
      servers: [
        {
          service: 'web',
          logPath: '/tmp/web.log',
          truncated: false,
          content:
            '=== karst run 2026-01-01T00:00:00.000Z ===\n' +
            '2026-01-01T00:00:00.100Z \u001b[32mready\u001b[0m in 412ms\n' +
            '2026-01-01T00:00:00.250Z GET /health \u001b[32m200\u001b[0m 3ms\n' +
            '2026-01-01T00:00:01.400Z \u001b[33mwarn\u001b[0m slow query 812ms\n',
        },
        {
          service: 'api',
          logPath: '/tmp/api.log',
          truncated: false,
          content:
            '2026-01-01T00:00:00.200Z connected to postgres\n' +
            '2026-01-01T00:00:01.100Z \u001b[31merror\u001b[0m upstream timeout\n',
        },
      ],
    },
  ],
};

/**
 * Seed a view from the checked-in render-fixture corpus its own render tests
 * already use, rather than from an invented payload.
 *
 * Reuse is the point: the visual baseline and the render test then pin the
 * SAME state, so a fixture change shows up in both rather than letting the two
 * drift into disagreeing about what the view looks like.
 *
 * Throws on an unknown scenario. A renamed scenario would otherwise silently
 * fall back to an empty state and be "fixed" by re-recording a blank baseline,
 * which is exactly the failure this corpus exists to end.
 */
function fromRenderFixtures<T extends { scenario: string; state: unknown }>(
  view: ViewId,
  fixtures: readonly T[],
  scenario: T['scenario'],
): ViewCorpus {
  const hit = fixtures.find((f) => f.scenario === scenario);
  if (!hit) {
    const known = fixtures.map((f) => f.scenario).join(', ');
    throw new Error(`${view}: no '${scenario}' render fixture (have: ${known})`);
  }
  return { messages: [{ type: 'state', state: hit.state }] };
}

/** The per-view corpus: a real fixture where one exists, MINIMAL otherwise. */
const MINIMAL_CORPORA: Record<ViewId, ViewCorpus> = {
  dashboard: dashboardCorpus(),
  // 'single-page' over 'paged-middle': one full page of rows with every column
  // populated, and no pager state that would pin a scroll offset into a baseline.
  usage: fromRenderFixtures('usage', usageRenderFixtures(), 'single-page'),
  // 'busy' over 'idle': idle renders real rows but near-zero meters, so a
  // regression in the bar geometry would not move enough pixels to fail.
  resources: fromRenderFixtures('resources', resourcesRenderFixtures(), 'busy'),
  serverLogs: SERVER_LOGS_CORPUS,
  // 'all-sections' renders current, recently-done and older-done together —
  // the only scenario that pins the section dividers and the facet counts.
  sidebar: fromRenderFixtures('sidebar', sidebarRenderFixtures(), 'all-sections'),
  // 'populated' over 'empty': two repos with commits and staged/unstaged/
  // untracked files so the tree view, the file list and the header counts
  // all render.
  diffs: fromRenderFixtures('diffs', diffsRenderFixtures(), 'populated'),
  settings: { messages: [{ type: 'state', state: MINIMAL_SETTINGS }] },
  ticketForm: { messages: [{ type: 'state', state: MINIMAL_TICKET_FORM }] },
  // 'partial' over 'fresh' or 'complete': a half-done checklist is the only
  // state that renders both the done and the outstanding row treatments.
  gettingStarted: fromRenderFixtures(
    'gettingStarted',
    gettingStartedRenderFixtures(),
    'partial',
  ),
};

export function getCorpus(view: ViewId): ViewCorpus {
  return MINIMAL_CORPORA[view]!;
}

/**
 * Views still on the MINIMAL seed.  Shrink-only: removing a view here is
 * a one-line edit when FEAT-37 delivers its corpus; adding a view is a
 * regression.
 *
 * Dashboard is excluded — its corpus exists today.  `serverLogs` is excluded
 * too: it seeds through its own `server-logs` protocol rather than the generic
 * `state` message this ratchet's members must speak.
 */
export const MINIMAL_RATCHET: readonly ViewId[] = [
  'settings',
  'ticketForm',
];

/** All nine view ids. */
export const ALL_VIEWS: readonly ViewId[] = [
  'dashboard',
  'usage',
  'resources',
  'serverLogs',
  'sidebar',
  'diffs',
  'settings',
  'ticketForm',
  'gettingStarted',
];
