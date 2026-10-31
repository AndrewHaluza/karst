/**
 * The variant registry (ui:UI-R57, ui:VISUAL-VARIANTS): every webview in
 * WEBVIEW_NAMES maps to the variants it declares, and every variant carries
 * (a) its corpus builder, (b) the baseline name and theme projects the sweep
 * records, and (c) the layout-gate target that opens it at every LAYOUT_WIDTHS
 * width. variants.test.ts fails when any of the three is missing.
 *
 * Builders reuse the render-fixture corpora and realisticSettings.ts so the
 * sweep and the render tests pin the same states. All data is fixed: no clock,
 * no random ids.
 */
import {
  populatedStateFor,
  renderStateFor,
  renderFixtures,
  sharedServerFixtures,
  shipPreviewStateFor,
  type RenderRepoCount,
  type RenderScenario,
} from '../../src/ui/dashboard/renderFixtures.js';
import type { DashboardState } from '../../src/ui/dashboard/state.js';
import { INSIDE_CASES } from '../../src/ui/dashboard/insideCases.js';
import { sidebarRenderFixtures } from '../../src/ui/sidebar/renderFixtures.js';
import { usageRenderFixtures } from '../../src/ui/usage/renderFixtures.js';
import { resourcesRenderFixtures } from '../../src/ui/resources/renderFixtures.js';
import { gettingStartedRenderFixtures } from '../../src/ui/gettingStarted/renderFixtures.js';
import { diffsRenderFixtures } from '../../src/ui/diffs/renderFixtures.js';
import { WEBVIEW_NAMES, type WebviewName } from '../../src/model/webviewChains.js';
import { formatAgentsHash } from '../../src/ui/settings/app/sections/agentsRoute.js';
import type { SettingsSection } from '../../src/ui/settings/sections.js';
import { settingsRoutes } from './settingsRoutes.js';
import {
  EMPTY_SETTINGS,
  LONG_BODY_PROFILE,
  REALISTIC_SETTINGS,
} from './realisticSettings.js';
import {
  getCorpus,
  MINIMAL_TICKET_FORM,
  type ViewCorpus,
} from './corpora.js';

export type ViewId = WebviewName;

/** Theme projects that record a screenshot for a variant. */
export const ALL_THEMES: readonly string[] = ['dark', 'light', 'hc'];
export const DARK_ONLY: readonly string[] = ['dark'];

/** Variants every view must declare (ui:UI-R57). */
export const MANDATORY_VARIANTS = ['populated', 'empty', 'loading', 'error', 'long-content'] as const;

export interface Variant {
  readonly id: string;
  /** Screenshot file stem inside each theme project's baseline folder. */
  readonly baseline: string;
  /** Theme projects that must hold `<baseline>.png`. */
  readonly themes: readonly string[];
  readonly corpus: () => ViewCorpus;
  /** Settings only: the nav section / hash to open before the shot. */
  readonly route?: { readonly section: SettingsSection; readonly hash?: string; readonly scrollTo?: string };
  /** Settings only: id of the settingsRoutes() entry that runs this variant's layout geometry. */
  readonly layoutRouteId?: string;
  /**
   * Screenshot-only: no layout-gate run. The ledger never grows, and a new dashboard route would inherit the
   * page's known failures (rail, PR rows), so a variant that adds no layout of its own opts out.
   */
  readonly skipLayout?: boolean;
  /** Screenshot viewport width override (px); absent = the project default. */
  readonly width?: number;
}

function variant(
  view: ViewId,
  id: string,
  corpus: () => ViewCorpus,
  opts: { baseline?: string; themes?: readonly string[]; skipLayout?: boolean; width?: number } = {},
): Variant {
  return {
    id,
    baseline: opts.baseline ?? `${view}--${id}`,
    themes: opts.themes ?? DARK_ONLY,
    corpus,
    ...(opts.skipLayout ? { skipLayout: true } : {}),
    ...(opts.width === undefined ? {} : { width: opts.width }),
  };
}

const stateMessage = (state: unknown): ViewCorpus => ({ messages: [{ type: 'state', state }] });
/** Before the first host message: what the webview renders while it waits. */
const LOADING: () => ViewCorpus = () => ({ messages: [] });
const LONG_TITLE =
  'Reconcile the long-running ticket workflow state across every repository worktree after a rebased base branch';

function fixtureCorpus<T extends { scenario: string; state: unknown }>(
  view: ViewId,
  fixtures: () => readonly T[],
  scenario: T['scenario'],
): () => ViewCorpus {
  return () => {
    const hit = fixtures().find((f) => f.scenario === scenario);
    if (!hit) throw new Error(`${view}: no '${scenario}' render fixture`);
    return stateMessage(hit.state);
  };
}

// ---------------------------------------------------------------- dashboard

function dashboardScenario(
  scenario: RenderScenario,
  repoCount: RenderRepoCount,
  patch: (s: DashboardState) => DashboardState = (s) => s,
): () => ViewCorpus {
  return () => {
    const f = renderFixtures().find((x) => x.repositoryCount === repoCount && x.scenario === scenario);
    if (!f) throw new Error(`dashboard: no ${scenario}/${repoCount} render fixture`);
    const state = populatedStateFor(f.stage);
    return stateMessage(patch({ ...state, insideViews: { ...state.insideViews, [f.stage]: f.view } }));
  };
}

/** ui:VISUAL-VARIANTS: one dark-only variant per Inside stage x state case (aliases reuse an older variant). */
const insideCaseVariants = (): Variant[] =>
  INSIDE_CASES.filter((c) => c.aliasOf === undefined).map((c) =>
    variant('dashboard', `inside-${c.stage}-${c.id}`, () => stateMessage(c.state()), c.skipLayout ? { skipLayout: true } : undefined),
  );

const dashboardVariants = (): Variant[] => [
  variant('dashboard', 'populated', dashboardScenario('running', 10), { baseline: 'dashboard-running', themes: ALL_THEMES }),
  ...(['pending', 'passed', 'failed', 'waiting', 'exhausted'] as const).map((s) =>
    variant('dashboard', s, dashboardScenario(s, 10), { baseline: `dashboard-${s}`, themes: ALL_THEMES }),
  ),
  variant('dashboard', 'empty', () => stateMessage(renderStateFor('scope'))),
  variant('dashboard', 'loading', LOADING),
  variant('dashboard', 'error', dashboardScenario('failed', 2)),
  variant('dashboard', 'long-content', dashboardScenario('running', 20, (s) => ({ ...s, title: LONG_TITLE }))),
  variant('dashboard', 'confirm-ship', () => stateMessage(shipPreviewStateFor('ready'))),
  variant('dashboard', 'ship-blocked', () => stateMessage(shipPreviewStateFor('blocked'))),
  variant('dashboard', 'ship-error', () => stateMessage(shipPreviewStateFor('error'))),
  // D159: a quota block is non-resumable; its banner carries Pick/Retry/Dismiss.
  variant('dashboard', 'usage-limit-blocked', dashboardScenario('running', 2, (s) => ({
    ...s,
    currentStage: {
      stageKey: 'review',
      status: 'running',
      blocked: { kind: 'usage-limit', reason: 'anthropic: monthly quota exceeded', at: '2026-01-01T00:00:00.000Z', resumable: false },
    },
  }))),
  // T853: out-of-memory kill park; the strip carries Run gate on host + Retry.
  variant('dashboard', 'resource-killed-blocked', dashboardScenario('running', 2, (s) => ({
    ...s,
    currentStage: {
      stageKey: 'uat',
      status: 'running',
      blocked: {
        kind: 'resource-killed',
        reason: 'Gate "unit" was killed (exit 137) in the sandbox, twice, with no failing test. Raise the Docker Desktop memory.',
        at: '2026-01-01T00:00:00.000Z',
        resumable: true,
      },
    },
  })), { skipLayout: true }),
  // T820: the Sub-tasks panel with a blocked blocker (usage-limit fault), a PR, an agent and a queued row.
  variant('dashboard', 'subtask-blocked', dashboardScenario('running', 2), { themes: ['dark', 'light'], skipLayout: true }),
  variant('dashboard', 'sandbox-on', dashboardScenario('running', 2, (s) => ({
    ...s,
    sandbox: {
      backend: 'docker',
      core: 'claude',
      workspace: 'clone',
      network: 'allowlist proxy on an internal network',
      actions: true,
      carry: false,
    },
  }))),
  // D203: the Servers panel's read-only shared half — one running from the base
  // branch, one stopped — beside the ticket's own rows.
  variant('dashboard', 'shared-services', dashboardScenario('running', 2, (s) => ({
    ...s,
    sharedServers: sharedServerFixtures(),
  }))),
  ...insideCaseVariants(),
  // D283: one-shot edge ring pulse when revealed, framed statically in reduced-motion state.
  variant('dashboard', 'attention', () => ({
    messages: [
      ...dashboardScenario('running', 2)().messages,
      { type: 'attention' },
    ],
  }), { baseline: 'dashboard--attention', themes: ['dark-reduced-motion'], skipLayout: true }),
];

// ----------------------------------------------------------------- settings

const LEGACY_SETTINGS_BASELINES: Readonly<Record<string, string>> = {
  [`agents${formatAgentsHash({ tab: 'roles' })}`]: 'agents-roles',
  'agents#agents/roles?compare=fast': 'agents-compare',
  [`agents${formatAgentsHash({ tab: 'profiles', selected: LONG_BODY_PROFILE })}`]: 'agents-profile',
};

function settingsRouteVariants(): Variant[] {
  return settingsRoutes().map((r) => {
    const id = `route-${r.id.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
    const legacy = LEGACY_SETTINGS_BASELINES[r.id];
    const route = { section: r.section, ...(r.hash === undefined ? {} : { hash: r.hash }) };
    return {
      ...variant('settings', id, () => stateMessage(REALISTIC_SETTINGS), {
        baseline: legacy ?? `settings--${id}`,
        themes: legacy === undefined ? DARK_ONLY : ALL_THEMES,
      }),
      route,
      layoutRouteId: r.id,
    };
  });
}

/** Quality route with `review.stallDetection` in one non-default state (UI-R57). */
function qualityStallVariant(id: string, stallDetection: Record<string, unknown>): Variant {
  const manifest = { ...REALISTIC_SETTINGS.manifest, review: { ...REALISTIC_SETTINGS.manifest.review, stallDetection } };
  return {
    ...variant('settings', id, () => stateMessage({ ...REALISTIC_SETTINGS, manifest } as never), {
      baseline: `settings--${id}`,
      themes: DARK_ONLY,
    }),
    route: { section: 'quality' },
  };
}

/** Quality route with UAT gates in one OOM-kill state: default, host-selected, or gate disabled (T853). */
function qualityKillVariant(id: string, gate: Record<string, unknown>): Variant {
  const manifest = { ...REALISTIC_SETTINGS.manifest, uat: { ...REALISTIC_SETTINGS.manifest.uat, gates: [{ name: 'unit', command: 'npm', args: ['test'], ...gate }] } };
  return {
    ...variant('settings', id, () => stateMessage({ ...REALISTIC_SETTINGS, manifest } as never), {
      baseline: `settings--${id}`,
      themes: DARK_ONLY,
      skipLayout: true,
    }),
    route: { section: 'quality', scrollTo: '.gate-block' },
  };
}

const settingsVariants = (): Variant[] => [
  variant('settings', 'populated', () => stateMessage(REALISTIC_SETTINGS), { baseline: 'settings--populated', themes: ALL_THEMES }),
  // The pre-registry MINIMAL page; its baselines predate the registry.
  variant('settings', 'minimal', () => getCorpus('settings'), { baseline: 'settings', themes: ALL_THEMES }),
  variant('settings', 'empty', () => stateMessage(EMPTY_SETTINGS)),
  variant('settings', 'loading', LOADING),
  variant('settings', 'error', () =>
    stateMessage({ ...REALISTIC_SETTINGS, error: 'karst.yml: repositories[1].path must be a string (line 14)' }),
  ),
  // 40+ char preset name, 60+ char model id and a 40+ line profile body.
  {
    ...variant('settings', 'long-content', () => stateMessage(REALISTIC_SETTINGS), { baseline: 'agents-profile', themes: ALL_THEMES }),
    route: { section: 'agents', hash: formatAgentsHash({ tab: 'profiles', selected: LONG_BODY_PROFILE }) },
    layoutRouteId: `agents${formatAgentsHash({ tab: 'profiles', selected: LONG_BODY_PROFILE })}`,
  },
  ...settingsRouteVariants().filter((v) => v.baseline !== 'agents-profile'),
  qualityStallVariant('quality-stall-disabled', { enabled: false, sameFileRounds: 3, repeatedFindingRounds: null }),
  qualityKillVariant('quality-oom-default', {}),
  qualityKillVariant('quality-oom-host', { onResourceKill: 'host' }),
  qualityKillVariant('quality-oom-disabled', { enabled: false }),
  qualityStallVariant('quality-stall-invalid', { enabled: true, sameFileRounds: 9, repeatedFindingRounds: 0 }),
];

// ----------------------------------------------------------------- others

const serverLogsVariants = (): Variant[] => {
  const entry = (service: string, content: string) => ({ service, logPath: `/tmp/${service}.log`, truncated: false, content });
  const logs = (...servers: ReturnType<typeof entry>[]): ViewCorpus => ({ messages: [{ type: 'server-logs', servers }] });
  const line = (n: number) => `2026-01-01T00:00:${String(n % 60).padStart(2, '0')}.000Z GET /health ${'x'.repeat(n % 7)} 200 3ms\n`;
  return [
    variant('serverLogs', 'populated', () => getCorpus('serverLogs'), { baseline: 'serverLogs', themes: ALL_THEMES }),
    variant('serverLogs', 'empty', () => logs()),
    variant('serverLogs', 'loading', LOADING),
    variant('serverLogs', 'error', () => logs(entry('api', '2026-01-01T00:00:00.000Z \u001b[31merror\u001b[0m ECONNREFUSED 127.0.0.1:5432\n'))),
    variant('serverLogs', 'long-content', () =>
      logs(
        entry('web-frontend-with-a-very-long-service-name-over-forty-chars', `2026-01-01T00:00:00.000Z ${'GET /very/long/path/segment/'.repeat(30)} 200\n`),
        entry('api', Array.from({ length: 400 }, (_, i) => line(i)).join('')),
      ),
    ),
    variant('serverLogs', 'streaming', () => ({
      messages: [
        ...logs(entry('web', line(1))).messages,
        { type: 'server-log-output', service: 'web', text: line(2) + line(3) },
      ],
    })),
  ];
};

const sidebarVariants = (): Variant[] => {
  const s = fixtureCorpus.bind(null, 'sidebar', sidebarRenderFixtures as () => readonly { scenario: string; state: unknown }[]);
  return [
    variant('sidebar', 'populated', () => getCorpus('sidebar'), { baseline: 'sidebar', themes: ALL_THEMES }),
    variant('sidebar', 'empty', s('empty')),
    variant('sidebar', 'loading', LOADING),
    variant('sidebar', 'error', s('hostile')),
    variant('sidebar', 'long-content', s('multi-facet')),
    variant('sidebar', 'planning-deps', s('planning-deps')),
    variant('sidebar', 'subtasks', s('subtasks')),
    variant('sidebar', 'filtered', s('filtered')),
    variant('sidebar', 'cloud-sessions', s('cloud-sessions')),
  ];
};

const usageVariants = (): Variant[] => {
  const u = fixtureCorpus.bind(null, 'usage', usageRenderFixtures as () => readonly { scenario: string; state: unknown }[]);
  return [
    variant('usage', 'populated', () => getCorpus('usage'), { baseline: 'usage', themes: ALL_THEMES }),
    variant('usage', 'empty', u('empty')),
    variant('usage', 'loading', LOADING),
    variant('usage', 'error', u('error')),
    variant('usage', 'long-content', u('hostile')),
    variant('usage', 'paged', u('paged-middle')),
    variant('usage', 'sorted', u('all-sorts')),
    variant('usage', 'quota', u('quota')),
  ];
};

const resourcesVariants = (): Variant[] => {
  const r = fixtureCorpus.bind(null, 'resources', resourcesRenderFixtures as () => readonly { scenario: string; state: unknown }[]);
  return [
    variant('resources', 'populated', () => getCorpus('resources'), { baseline: 'resources', themes: ALL_THEMES }),
    variant('resources', 'empty', r('idle')),
    variant('resources', 'loading', LOADING),
    variant('resources', 'error', r('degraded')),
    variant('resources', 'long-content', r('hostile')),
    variant('resources', 'unsupported', r('unsupported')),
    variant('resources', 'waste', r('waste')),
    variant('resources', 'unattributed', r('unattributed')),
  ];
};

const diffsVariants = (): Variant[] => {
  const d = fixtureCorpus.bind(null, 'diffs', diffsRenderFixtures as () => readonly { scenario: string; state: unknown }[]);
  return [
    variant('diffs', 'populated', () => getCorpus('diffs'), { baseline: 'diffs', themes: ALL_THEMES }),
    variant('diffs', 'empty', d('empty')),
    variant('diffs', 'loading', LOADING),
    variant('diffs', 'error', d('error')),
    variant('diffs', 'long-content', d('hostile')),
  ];
};

const gettingStartedVariants = (): Variant[] => {
  const g = fixtureCorpus.bind(null, 'gettingStarted', gettingStartedRenderFixtures as () => readonly { scenario: string; state: unknown }[]);
  return [
    variant('gettingStarted', 'populated', () => getCorpus('gettingStarted'), { baseline: 'gettingStarted', themes: ALL_THEMES }),
    variant('gettingStarted', 'empty', g('empty')),
    variant('gettingStarted', 'loading', LOADING),
    // No host-failure state exists for this view; the fresh checklist (nothing configured) is its unhappy path.
    variant('gettingStarted', 'error', g('fresh')),
    variant('gettingStarted', 'long-content', g('hostile')),
    variant('gettingStarted', 'complete', g('complete')),
  ];
};

/**
 * The routed-model catalog the `routed-model` variant seeds: a gateway with a
 * vendor segment (OpenRouter), a vendor-less subscription route (OpenCode Go),
 * a `:free` suffix and a `-free` suffix — the id shapes the picker must read.
 */
const ROUTED_MODEL_CATALOG = {
  claude: [{ id: 'claude-sonnet-5', label: 'Sonnet 5', providers: ['claude'], efforts: ['low', 'medium', 'high'] }],
  codex: [],
  antigravity: [],
  opencode: [],
  opencode2: [
    {
      id: 'opencode-go/deepseek-v4.1-flash',
      label: 'OpenCode Go \u00b7 DeepSeek v4.1 Flash',
      providers: ['opencode2'],
      efforts: ['low', 'high', 'max'],
    },
    { id: 'openrouter/mancer/weaver', label: 'weaver', providers: ['opencode2'] },
    { id: 'openrouter/liquid/lfm-2.5-2.6b:free', label: 'LFM 2.5 2.6B', providers: ['opencode2'] },
    { id: 'opencode/big-pickle-free', label: 'big-pickle-free', providers: ['opencode2'] },
  ],
};

/** Layout B′ realistic state (ui:UI-R57): clickup, 3 repos (one non-runnable), 3 described approaches, 2 presets, 1 attachment. */
const REALISTIC_TICKET_FORM = {
  provider: 'clickup',
  ticketSearchEnabled: true,
  canCreateProviderTicket: true,
  sourceRef: '869e889uh',
  title: 'Add per-repo base branch override to the ticket form',
  description: 'Let a ticket pick its base branch per repository, defaulting to the manifest baseline.',
  intent: 'Pick a base branch per repo, save, and confirm the worktree starts from it.',
  repos: [
    { service: 'karst', signals: [], score: 0, runnable: true, docker: false, selected: true },
    { service: 'docs-site', signals: [], score: 0, runnable: true, docker: false, selected: false },
    { service: 'infra', signals: [], score: 0, runnable: false, docker: false, selected: false },
  ],
  repoBases: [
    { repo: 'karst', value: '', default: 'develop', source: 'manifest', candidates: ['develop', 'main'] },
  ],
  approaches: [
    { id: 'tdd', label: 'TDD', description: 'Write failing tests first, then the smallest change.', recommended: true, installed: true },
    { id: 'research', label: 'Research first', description: 'Investigate and write findings before any code.', installed: true },
    { id: 'quick', label: 'Quick fix', description: 'Small, low-risk edit without a plan.', installed: true },
  ],
  selectedApproach: 'tdd',
  agentProviders: ['claude', 'codex'],
  agentPresetNames: ['fast', 'deep'],
  selectedAgentPreset: 'fast',
  modelCatalog: ROUTED_MODEL_CATALOG,
  recentModels: {},
  sessionOpen: false,
  attachments: [{ id: 1, kind: 'image', name: 'layout-at-480px.png', byteSize: 48213, src: '' }],
};

const BRIEF_FULL = {
  title: 'Add per-repo base branch override',
  description: Array.from({ length: 2 }, (_, i) => `Requirement line ${i + 1}: keep the manifest baseline as the default.`).join('\n'),
  tags: ['frontend', 'picker'],
  status: 'in progress',
  priority: 'high',
  people: [
    { name: 'Jo Lee', role: 'assignee' },
    { name: 'Mika Kato', role: 'reporter' },
  ],
  attachments: [{ name: 'current-picker.png', url: 'https://app.clickup.com/a/1' }],
  comments: [
    { author: 'Mika Kato', text: 'Design attached. '.repeat(3), date: '2026-10-29T10:30:00Z' },
  ],
  url: 'https://app.clickup.com/t/869e889uh',
};
const BRIEF_MINIMAL = {
  title: 'Add per-repo base branch override',
  description: 'Let a ticket pick its base branch per repository.',
  tags: [],
  comments: [],
  attachments: [],
  url: 'https://app.clickup.com/t/869e889uh',
};

const ticketFormVariants = (): Variant[] => {
  const base = MINIMAL_TICKET_FORM;
  const withState = (patch: Record<string, unknown>): ViewCorpus => stateMessage({ ...base, ...patch });
  const edit = {
    mode: 'edit',
    ticketId: 42,
    refLabel: 'T42 · FEAT-42',
    key: 'FEAT-42',
    title: 'Add per-repo override to the picker',
    description: 'Let a ticket pick its base branch per repository.',
    stepper: [],
    attachments: [],
  };
  return [
    variant('ticketForm', 'populated', () => getCorpus('ticketForm'), { baseline: 'ticketForm', themes: ALL_THEMES }),
    variant('ticketForm', 'empty', () => withState({})),
    variant('ticketForm', 'loading', LOADING),
    variant('ticketForm', 'error', () => ({
      messages: [
        ...withState({}).messages,
        { type: 'error', message: 'Could not fetch FEAT-9999: the provider returned 404 (check the list id).' },
      ],
    })),
    // D159: an op that died on quota carries its park id, so the error notification
    // offers Pick agent/model, Retry same and Dismiss.
    variant('ticketForm', 'usage-limit-error', () => ({
      messages: [
        ...withState({}).messages,
        {
          type: 'error',
          message: 'anthropic: monthly quota exceeded. Pick another agent/model, retry, or dismiss.',
          usageLimitParkId: 7,
        },
      ],
    })),
    variant('ticketForm', 'long-content', () =>
      withState({ ...edit, key: 'FEAT-'.concat('9'.repeat(40)), title: LONG_TITLE, description: `${LONG_TITLE}. `.repeat(40) }),
    ),
    variant('ticketForm', 'edit', () => withState(edit)),
    // T838 (ui:UI-R57): the provider-derived "Also create in <badge>" switch.
    variant('ticketForm', 'clickup-create-in', () =>
      withState({ provider: 'clickup', canCreateProviderTicket: true }),
    ),
    // T777: the shared picker's routed-model stack — the route mark, the model
    // name over its gateway vendor, and the `free` tag. Seeded in the TICKET
    // FORM because its full-page baseline is the only picker host whose picker
    // sits inside the captured area: the Agents Roles table lives in an
    // internal scroll region below the settings page's 720px crop, so an
    // agents-* baseline can never show it.
    variant(
      'ticketForm',
      'routed-model',
      () =>
        withState({
          ...edit,
          title: 'Route the picker through OpenRouter',
          description: 'A multi-provider model id, read at a glance.',
          agentProviders: ['claude', 'codex', 'antigravity', 'opencode', 'opencode2'],
          selectedAgentProvider: 'opencode2',
          defaultAgentProvider: 'opencode2',
          selectedModel: 'openrouter/mancer/weaver',
          defaultModel: 'opencode-go/deepseek-v4.1-flash',
          selectedEffort: null,
          defaultEffort: null,
          modelCatalog: ROUTED_MODEL_CATALOG,
          recentModels: {},
          sessionOpen: false,
        }),
      { themes: ALL_THEMES },
    ),
    // T839: the picker's opt-in Preset | Core + model switch. `agent-preset` is
    // the preset tab (core/model/effort hidden); `agent-core-model` is the
    // core tab with all three controls, the effort showing because the
    // model advertises efforts.
    variant('ticketForm', 'agent-preset', () =>
      withState({
        ...edit,
        agentProviders: ['claude', 'codex', 'antigravity', 'opencode', 'opencode2'],
        agentPresetNames: ['fast', 'deep'],
        selectedAgentPreset: 'fast',
        modelCatalog: ROUTED_MODEL_CATALOG,
        recentModels: {},
        sessionOpen: false,
      }),
    ),
    variant('ticketForm', 'agent-core-model', () =>
      withState({
        ...edit,
        agentProviders: ['claude', 'codex', 'antigravity', 'opencode', 'opencode2'],
        agentPresetNames: ['fast', 'deep'],
        selectedAgentPreset: null,
        selectedAgentProvider: 'claude',
        defaultAgentProvider: 'claude',
        selectedModel: 'claude-sonnet-5',
        selectedEffort: 'high',
        modelCatalog: ROUTED_MODEL_CATALOG,
        recentModels: {},
        sessionOpen: false,
      }),
    ),
    // Layout B′ (ui:UI-R57, prototype docs/design/ticket-form-b-prime.html).
    variant('ticketForm', 'realistic-create', () => withState(REALISTIC_TICKET_FORM)),
    variant('ticketForm', 'realistic-edit', () =>
      withState({ ...REALISTIC_TICKET_FORM, ...edit, title: REALISTIC_TICKET_FORM.title, refLabel: 'T42 · FEAT-42' }),
    ),
    variant('ticketForm', 'subtask', () =>
      withState({
        ...REALISTIC_TICKET_FORM,
        subtaskOf: 'Sub-task of T12',
        repoBases: [
          { repo: 'karst', value: '', default: 'karst/feat/parent', defaultLabel: 'parent branch: karst/feat/parent (default)', source: 'parent', candidates: [] },
        ],
      }),
    ),
    variant('ticketForm', 'session-open', () =>
      withState({ ...REALISTIC_TICKET_FORM, ...edit, title: REALISTIC_TICKET_FORM.title, sessionOpen: true }),
    ),
    variant('ticketForm', 'narrow-480', () => withState(REALISTIC_TICKET_FORM), { width: 480 }),
    variant('ticketForm', 'tight-320', () => withState(REALISTIC_TICKET_FORM), { width: 320 }),
    // D287: the inline brief card — expanded with meta, attachment and comments,
    // and the minimal tags-only brief; the approach picker with descriptions; a
    // manual ticket's header.
    variant('ticketForm', 'brief-expanded', () => ({
      messages: [
        ...withState({ ...REALISTIC_TICKET_FORM, attachments: [], description: '' }).messages,
        { type: 'brief', brief: BRIEF_FULL },
      ],
    })),
    variant('ticketForm', 'brief-minimal', () => ({
      messages: [
        ...withState(REALISTIC_TICKET_FORM).messages,
        { type: 'brief', brief: BRIEF_MINIMAL },
      ],
    })),
    variant('ticketForm', 'approach-picker', () => withState(REALISTIC_TICKET_FORM)),
    variant('ticketForm', 'manual-provider', () => withState({ ...REALISTIC_TICKET_FORM, provider: 'manual', sourceRef: '' })),
    variant('ticketForm', 'attachments', () =>
      withState({
        ...edit,
        attachments: [
          { id: 1, kind: 'image', name: 'screenshot-of-the-failing-layout-at-480px-width.png', byteSize: 48213, src: '' },
          { id: 2, kind: 'file', name: 'trace.zip', byteSize: 2_345_678, src: '' },
        ],
      }),
    ),
  ];
};

const BUILDERS: Readonly<Record<ViewId, () => Variant[]>> = {
  dashboard: dashboardVariants,
  diffs: diffsVariants,
  gettingStarted: gettingStartedVariants,
  resources: resourcesVariants,
  serverLogs: serverLogsVariants,
  settings: settingsVariants,
  sidebar: sidebarVariants,
  ticketForm: ticketFormVariants,
  usage: usageVariants,
};

/** view → declared variants, in declaration order. Builders run lazily per call. */
export const VARIANTS: Readonly<Record<ViewId, readonly Variant[]>> = Object.fromEntries(
  WEBVIEW_NAMES.map((v) => [v, BUILDERS[v]()]),
) as unknown as Record<ViewId, readonly Variant[]>;

/** Fixture page file (inside each theme folder) for one variant. */
export function fixtureFile(view: ViewId, variantId: string): string {
  return `${view}--${variantId}.html`;
}

export interface LayoutTarget {
  /** Report / ledger id: `<view>/<variant>`, or the existing settings route id. */
  readonly id: string;
  readonly view: ViewId;
  readonly variant: Variant;
}

/** Layout-gate runs, one per variant; settings route variants reuse their settingsRoutes() id. */
export function layoutTargets(): readonly LayoutTarget[] {
  return WEBVIEW_NAMES.flatMap((view) =>
    VARIANTS[view]
      .filter((variant) => !variant.skipLayout)
      .map((variant) => ({
        id: variant.layoutRouteId ?? `${view}/${variant.id}`,
        view,
        variant,
      })),
  );
}

/** Layout targets that are not settings routes: settings routes keep their settingsRoutes() runs. */
export function extraLayoutTargets(): readonly LayoutTarget[] {
  return layoutTargets().filter((t) => t.variant.layoutRouteId === undefined);
}
