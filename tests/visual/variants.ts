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
import { renderBrief } from '../../src/integrations/briefMarkdown.js';
import type { DashboardState } from '../../src/ui/dashboard/state.js';
import { INSIDE_CASES } from '../../src/ui/dashboard/insideCases.js';
import { stallFixtureState, type StallFixtureKind } from '../../src/ui/dashboard/stallFixtures.js';
import { sidebarRenderFixtures } from '../../src/ui/sidebar/renderFixtures.js';
import { usageRenderFixtures } from '../../src/ui/usage/renderFixtures.js';
import { resourcesRenderFixtures } from '../../src/ui/resources/renderFixtures.js';
import { gettingStartedRenderFixtures } from '../../src/ui/gettingStarted/renderFixtures.js';
import { diffsRenderFixtures } from '../../src/ui/diffs/renderFixtures.js';
import { WEBVIEW_NAMES, type WebviewName } from '../../src/model/webviewChains.js';
import { formatAgentsHash } from '../../src/ui/settings/app/sections/agentsRoute.js';
import type { SettingsSection } from '../../src/ui/settings/sections.js';
import { settingsRoutes } from './settingsRoutes.js';
import { PANEL_TIERS, PANEL_VARIANTS } from './panelVariants.js';
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
  /** Dashboard drill-downs: pill names clicked, in order, after the page loads (the restored artifact index shows the pills). */
  readonly pills?: readonly string[];
  /** Dashboard agent popover: open it after load, then pick a core, type a query, pick a capability tab (in that order). */
  readonly agentPopover?: AgentPopoverSteps;
  /** Dashboard ticket details drawer: open it from the doc icon after load, then pick a tab. */
  readonly ticketDetails?: TicketDetailsSteps;
  /** Dashboard runtime strip: open this popover after load (the sandbox details or the ⋯ menu). */
  readonly runtimeOpen?: RuntimeOpen;
  /** Dashboard panels: a selector clicked after load (a popover trigger). */
  readonly click?: string;
}

/** The interaction steps of a ticket-details drawer variant: open it from the doc icon, then pick a tab. */
export interface TicketDetailsSteps {
  readonly tab?: 'desc' | 'raw';
}

export type RuntimeOpen = 'sandbox' | 'more';

/** The interaction steps of an agent-popover variant. */
export interface AgentPopoverSteps {
  readonly core?: string;
  readonly q?: string;
  readonly cap?: string;
  /** A model id to pick after the core / query / tab steps. */
  readonly model?: string;
}

function variant(
  view: ViewId,
  id: string,
  corpus: () => ViewCorpus,
  opts: {
    baseline?: string;
    themes?: readonly string[];
    skipLayout?: boolean;
    width?: number;
    pills?: readonly string[];
    agentPopover?: AgentPopoverSteps;
    ticketDetails?: TicketDetailsSteps;
    runtimeOpen?: RuntimeOpen;
    click?: string;
  } = {},
): Variant {
  return {
    id,
    baseline: opts.baseline ?? `${view}--${id}`,
    themes: opts.themes ?? DARK_ONLY,
    corpus,
    ...(opts.skipLayout ? { skipLayout: true } : {}),
    ...(opts.width === undefined ? {} : { width: opts.width }),
    ...(opts.pills === undefined ? {} : { pills: opts.pills }),
    ...(opts.agentPopover === undefined ? {} : { agentPopover: opts.agentPopover }),
    ...(opts.ticketDetails === undefined ? {} : { ticketDetails: opts.ticketDetails }),
    ...(opts.runtimeOpen === undefined ? {} : { runtimeOpen: opts.runtimeOpen }),
    ...(opts.click === undefined ? {} : { click: opts.click }),
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
  INSIDE_CASES.filter((c) => c.aliasOf === undefined && c.id !== 'live-tokens').map((c) =>
    variant('dashboard', `inside-${c.stage}-${c.id}`, () => stateMessage(c.state()), { ...(c.skipLayout ? { skipLayout: true } : {}), ...(c.allThemes ? { themes: ALL_THEMES } : {}) }),
  );

/** T1018: the auto-deliver lines of the Deliver row at the mid and narrow tiers (the wide tier is the plain case). */
const deliverAutoTierVariants = (): Variant[] =>
  INSIDE_CASES.filter((c) => c.id.startsWith('deliver-auto-')).flatMap((c) =>
    ([['mid', 800], ['narrow', 360]] as const).map(([tier, width]) =>
      variant('dashboard', `inside-${c.stage}-${c.id}-${tier}`, () => stateMessage(c.state()), { skipLayout: true, width }),
    ),
  );

/** T1069 (B9): the live token pill at the wide, mid and narrow tiers. */
const liveTokenVariants = (): Variant[] =>
  INSIDE_CASES.filter((c) => c.id === 'live-tokens').flatMap((c) =>
    ([['wide', 1100], ['mid', 800], ['narrow', 500]] as const).map(([tier, width]) =>
      variant('dashboard', `inside-live-tokens-${tier}`, () => stateMessage(c.state()), { skipLayout: true, width }),
    ),
  );

/** T1001: the stall panel in each state, in all three themes. Screenshot-only: the panel adds no layout route. */
const stallVariants = (): Variant[] => {
  const one = (id: string, kind: StallFixtureKind, extra: { width?: number; pills?: readonly string[] } = {}): Variant =>
    variant('dashboard', id, () => stateMessage(stallFixtureState(kind)), { themes: ALL_THEMES, skipLayout: true, ...extra });
  return [
    one('stall-generating', 'generating'),
    one('stall-several', 'several'),
    one('stall-one', 'one'),
    one('stall-failed', 'failed'),
    one('stall-applying', 'several', { pills: ['Apply'] }),
    one('stall-several-narrow', 'several', { width: 480 }),
  ];
};

/** The four container tiers (UI-R49): a viewport width inside each. */
const DRILL_TIERS = [['wide', 1100], ['mid', 800], ['narrow', 500], ['tight', 360]] as const;
const DRILL_SURFACES = [['index', []], ['env', ['Env variables']], ['logs', ['Server logs']], ['console', ['Console']]] as const;
/** T871: the artifact index restored from the persisted view, so the drill-down pills are on screen. */
const drillCorpus = (mutate: (s: DashboardState) => DashboardState = (s) => s): (() => ViewCorpus) => () => {
  const corpus = dashboardScenario('running', 2, mutate)();
  // An envelope restores an artifact view only over a snapshot, so the state travels with it.
  const snapshot = (corpus.messages as readonly { type?: string; state?: unknown }[]).find((m) => m.type === 'state')?.state;
  return { ...corpus, viewState: { state: snapshot, artView: 'index' } };
};

/** The Console pill needs a stream behind it: every stage view carries a console. */
const withConsoles = (s: DashboardState): DashboardState => ({
  ...s,
  insideViews: Object.fromEntries(Object.entries(s.insideViews ?? {}).map(([k, v]) => [k, { ...v, console: true }])) as unknown as DashboardState['insideViews'],
});

/** Every drill-down surface at every tier, and the long identity at the extremes. */
const drillDownVariants = (): Variant[] => [
  ...DRILL_SURFACES.flatMap(([surface, pills]) =>
    DRILL_TIERS.map(([tier, width]) => variant('dashboard', `drill-${surface}-${tier}`, drillCorpus(withConsoles), { width, pills, skipLayout: true })),
  ),
  ...DRILL_TIERS.map(([tier, width]) =>
    variant('dashboard', `drill-long-identity-${tier}`, drillCorpus((s) => ({ ...s, title: LONG_TITLE, key: 'PLATFORM-INFRA-1234567' })), { width, skipLayout: true }),
  ),
];

/** A routed, capability-tagged catalog covering every picker state (efforts, no efforts, free, vision, audio). */
const AGENT_POPOVER_CATALOG = {
  claude: [
    { id: 'claude-opus-5', label: 'Opus 5', tags: ['vision', 'multimodal'], efforts: ['low', 'medium', 'high'] },
    { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', tags: ['vision'], efforts: ['low', 'high'] },
  ],
  codex: [
    { id: 'gpt-5-codex', label: 'GPT-5 Codex', tags: ['text-only'], efforts: ['low', 'medium', 'high'] },
    { id: 'gpt-5-mini', label: 'GPT-5 Mini', tags: ['vision'], efforts: [] },
  ],
  antigravity: [
    { id: 'gemini-3-pro', label: 'Gemini 3 Pro', tags: ['vision', 'multimodal', 'audio'], efforts: ['low', 'high'] },
  ],
  opencode: [
    { id: 'opencode/big-pickle', label: 'Big Pickle', tags: ['text-only'], efforts: [] },
    { id: 'opencode/kimi-k3-free', label: 'Kimi K3 Free', tags: ['text-only'], efforts: [] },
    { id: 'opencode-go/glm-5', label: 'GLM 5', tags: ['vision'], efforts: ['low', 'high'] },
    { id: 'openrouter/google/gemini-3-pro', label: 'Gemini 3 Pro', tags: ['vision', 'multimodal', 'audio'], efforts: ['low', 'high'] },
  ],
  opencode2: [
    { id: 'opencode/big-pickle', label: 'Big Pickle', tags: ['text-only'], efforts: [] },
  ],
};

/** The running dashboard with the five-core registry, one core not installed, and a full catalog. */
const agentPopoverCorpus = (): ViewCorpus =>
  dashboardScenario('running', 2, (s) => ({
    ...s,
    agentSwitch: {
      ...s.agentSwitch,
      cores: [
        { id: 'claude', label: 'Claude Code' },
        { id: 'codex', label: 'Codex' },
        { id: 'antigravity', label: 'Antigravity' },
        { id: 'opencode', label: 'OpenCode' },
        { id: 'opencode2', label: 'OpenCode 2', disabledReason: 'not installed' },
      ],
      modelsByCore: AGENT_POPOVER_CATALOG as unknown as typeof s.agentSwitch.modelsByCore,
      recentByCore: { opencode: ['opencode/big-pickle'] },
    },
    agentSession: s.agentSession && { ...s.agentSession, provider: 'claude', modelId: 'claude-opus-5', modelLabel: 'Opus 5' },
  }))();

const AGENT_POPOVER_TIERS = [['wide', 1100], ['mid', 800], ['narrow', 400]] as const;
const agentPopoverVariant = (id: string, steps: AgentPopoverSteps, width: number): Variant =>
  variant('dashboard', `agent-popover-${id}`, agentPopoverCorpus, { skipLayout: true, width, agentPopover: steps });

/** T1011: the shared picker in staged mode, one variant per core / query / tab state at wide, mid and narrow. */
const agentPopoverVariants = (): Variant[] => [
  ...AGENT_POPOVER_TIERS.map(([tier, width]) => agentPopoverVariant(`claude-${tier}`, {}, width)),
  ...['codex', 'antigravity', 'opencode'].map((core) => agentPopoverVariant(`${core}-wide`, { core }, 1100)),
  agentPopoverVariant('search-wide', { core: 'opencode', q: 'pickle' }, 1100),
  agentPopoverVariant('zero-count-tab-wide', { core: 'opencode', q: 'pickle', cap: 'text-only' }, 1100),
  agentPopoverVariant('no-effort-model-wide', { core: 'opencode', model: 'opencode/big-pickle' }, 1100),
  agentPopoverVariant('opencode-narrow', { core: 'opencode', q: 'pickle' }, 400),
];

// ---------------------------------------------------------------- ticket details drawer

const DETAILS_RICH_BRIEF = renderBrief({
  title: 'Add per-repo base branch override', description: 'The picker needs a **base branch** per repository.\n\n- Read `karst.yml`\n- Show the override\n\nSee [the spec](https://example.test/spec).',
  tags: ['worktrees', 'picker'], status: 'in review', priority: 'high', milestone: 'Sprint 42', url: 'https://example.test/browse/FEAT-142',
  people: [{ role: 'assignee', name: 'Ada Lovelace' }, { role: 'reporter', name: 'Grace Hopper' }],
  relations: [{ kind: 'blocked-by', ref: 'FEAT-100', title: 'Manifest loader', status: 'done' }, { kind: 'related', ref: 'FEAT-150' }],
  timestamps: { created: '2026-10-01', updated: '2026-11-02', due: '2026-11-20' }, links: ['https://example.test/design'],
  comments: [{ author: 'Ada', text: 'Looks right to me.', date: '' }, { author: 'Grace', text: 'Ship it after the picker lands.', date: '' }],
  attachments: [{ name: 'mock.png', size: '48 KB', url: 'https://example.test/mock.png' } as never],
});
const DETAILS_DRAFT_BRIEF = [
  '## Planning brief', 'Priority: normal (planner: readability of the ticket brief.)', 'Decisions:',
  '- Replace the raw drawer with a structured one.', '', '## Design constraints', '- @ui:UI-R39', '- @arch:SHELF', '- 0b5696078a6', '- D400',
].join('\n');

const detailsState = (patch: Partial<DashboardState>) => (s: DashboardState): DashboardState => ({ ...s, ...patch });
const DETAILS_STATES: ReadonlyArray<readonly [string, (s: DashboardState) => DashboardState]> = [
  ['rich', detailsState({ brief: DETAILS_RICH_BRIEF, description: 'Original description from the tracker.', provider: 'jira', ticketUrl: 'https://example.test/browse/FEAT-142', briefSource: { kind: 'provider', provider: 'jira' }, priority: 'high' } as Partial<DashboardState>)],
  ['draft', detailsState({ brief: DETAILS_DRAFT_BRIEF, description: '', provider: null, ticketUrl: null, briefSource: { kind: 'draft', draftId: 400 } } as Partial<DashboardState>)],
  ['plain', detailsState({ brief: '', description: 'Fix the login modal so it traps focus.', provider: 'github', ticketUrl: 'https://example.test/issues/9', briefSource: { kind: 'manual' } } as Partial<DashboardState>)],
  ['empty', detailsState({ brief: '', description: '', provider: null, ticketUrl: null, briefSource: { kind: 'manual' } } as Partial<DashboardState>)],
];
const DETAILS_TIERS = [['wide', 1100], ['mid', 800], ['narrow', 400]] as const;
const DETAILS_TABS: Readonly<Record<string, readonly (TicketDetailsSteps['tab'] | undefined)[]>> = {
  rich: [undefined, 'desc', 'raw'], draft: [undefined, 'raw'], plain: [undefined, 'raw'], empty: [undefined],
};

/** T1060: the four states x their tabs at wide, mid and narrow. The drawer is a fixed overlay: no layout run of its own. */
const ticketDetailsVariants = (): Variant[] =>
  DETAILS_STATES.flatMap(([name, patch]) =>
    (DETAILS_TABS[name] ?? []).flatMap((tab) =>
      DETAILS_TIERS.map(([tier, width]) =>
        variant('dashboard', `ticket-details-${name}${tab ? `-${tab}` : ''}-${tier}`, dashboardScenario('running', 2, patch), {
          skipLayout: true,
          width,
          ticketDetails: tab ? { tab } : {},
        }),
      ),
    ),
  );

type SandboxView = NonNullable<DashboardState['sandbox']>;
const SBX_VIEW: SandboxView = {
  backend: 'docker',
  core: 'claude',
  workspace: 'clone',
  network: 'allowlist proxy on an internal network',
  actions: true,
  carry: false,
  shell: { available: true, why: null },
};
const HOST_VIEW: SandboxView = {
  backend: 'host',
  core: 'claude',
  workspace: 'worktree',
  network: 'none (host)',
  actions: false,
  carry: false,
  shell: { available: false, why: 'No sandbox yet' },
};

/** The runtime strip: one scenario per state. Each state shoots at wide, mid and narrow. */
const RUNTIME_STATES: ReadonlyArray<readonly [string, (s: DashboardState) => DashboardState]> = [
  ['docker', (s) => ({ ...s, sandbox: SBX_VIEW })],
  ['sbx', (s) => ({ ...s, sandbox: { ...SBX_VIEW, backend: 'sbx', network: 'sbx network policy (allowlist)' } })],
  ['carry', (s) => ({ ...s, sandbox: { ...SBX_VIEW, carry: true } })],
  ['shell-off', (s) => ({ ...s, sandbox: { ...SBX_VIEW, shell: { available: false, why: 'Sandbox is stopped' } } })],
  ['host-ok', (s) => ({ ...s, sandbox: { ...HOST_VIEW, hostProtection: 'core-native' } })],
  ['host-warn', (s) => ({ ...s, sandbox: { ...HOST_VIEW, hostProtection: 'prompted' } })],
  ['host-note', (s) => ({ ...s, sandbox: { ...HOST_VIEW, hostProtection: 'prompted', note: 'antigravity: sbx backend unsupported' } })],
  ['locked', (s) => ({ ...s, sandbox: SBX_VIEW, agentSession: s.agentSession && { ...s.agentSession, canSwitch: false } })],
  ['idle-effort', (s) => ({ ...s, agentState: 'idle', sandbox: SBX_VIEW, agentSession: s.agentSession && { ...s.agentSession, effort: 'high' } })],
];
const RUNTIME_TIERS = [['wide', 1100], ['mid', 800], ['narrow', 400]] as const;

const runtimeStripVariants = (): Variant[] => [
  ...RUNTIME_STATES.flatMap(([id, patch]) =>
    RUNTIME_TIERS.map(([tier, width]) =>
      variant('dashboard', `runtime-${id}-${tier}`, dashboardScenario('running', 2, patch), { skipLayout: true, width }),
    ),
  ),
  ...(['sandbox', 'more'] as const).flatMap((open) =>
    RUNTIME_TIERS.map(([tier, width]) =>
      variant('dashboard', `runtime-${open}-open-${tier}`, dashboardScenario('running', 2, (s) => ({ ...s, sandbox: SBX_VIEW })), {
        skipLayout: true,
        width,
        runtimeOpen: open,
      }),
    ),
  ),
  // The first runtime variant keeps full layout checks (the strip is new page layout).
  variant('dashboard', 'sandbox-on', dashboardScenario('running', 2, (s) => ({ ...s, sandbox: SBX_VIEW }))),
];

/** T1063: every Servers / Worktrees / Pull requests state at wide, mid and narrow, plus the narrow sub-task row. */
const panelStateVariants = (): Variant[] => [
  ...PANEL_VARIANTS.flatMap((v) =>
    PANEL_TIERS.map(([tier, width]) =>
      variant('dashboard', `panel-${v.id}-${tier}`, dashboardScenario('running', 2, v.patch), {
        skipLayout: true,
        width,
        ...(v.click === undefined ? {} : { click: v.click }),
      }),
    ),
  ),
  variant('dashboard', 'subtask-narrow', dashboardScenario('running', 2), { skipLayout: true, width: 400 }),
];

const dashboardVariants = (): Variant[] => [
  variant('dashboard', 'populated', dashboardScenario('running', 10), { baseline: 'dashboard-running', themes: ALL_THEMES }),
  ...(['pending', 'passed', 'failed', 'waiting', 'exhausted'] as const).map((s) =>
    variant('dashboard', s, dashboardScenario(s, 10), { baseline: `dashboard-${s}`, themes: ALL_THEMES }),
  ),
  ...stallVariants(),
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
  // T938: the same park in the UAT lane; the title names the lane ("Provider out of quota — UAT Tester").
  variant('dashboard', 'usage-limit-blocked-uat', dashboardScenario('running', 2, (s) => ({
    ...s,
    currentStage: {
      stageKey: 'uat',
      status: 'running',
      blocked: { kind: 'usage-limit', reason: 'anthropic: monthly quota exceeded', at: '2026-01-01T00:00:00.000Z', resumable: false },
    },
  })), { skipLayout: true }),
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
  ...runtimeStripVariants(),
  ...panelStateVariants(),
  // D203: the Servers panel's read-only shared half — one running from the base
  // branch, one stopped — beside the ticket's own rows.
  variant('dashboard', 'shared-services', dashboardScenario('running', 2, (s) => ({
    ...s,
    sharedServers: sharedServerFixtures(),
  }))),
  ...insideCaseVariants(),
  ...deliverAutoTierVariants(),
  ...liveTokenVariants(),
  ...agentPopoverVariants(),
  ...ticketDetailsVariants(),
  ...drillDownVariants(),
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

/** Autopilot route in one state: off is the default `route-autopilot`; on and a host fault are these (T1004). */
function autopilotVariant(id: string, over: Record<string, unknown>, validation?: { ok: false; error: string }): Variant {
  const manifest = { ...REALISTIC_SETTINGS.manifest, ...over };
  return {
    ...variant('settings', id, () => stateMessage({ ...REALISTIC_SETTINGS, manifest, ...(validation ? { validation } : {}) } as never), {
      baseline: `settings--${id}`,
      themes: ALL_THEMES,
      skipLayout: true,
    }),
    route: { section: 'autopilot' },
  };
}

const AUTOPILOT_ON = {
  autopilot: { enabled: true, ci: { policy: 'auto', maxAttempts: 3, checks: ['lint', 'typecheck'] }, conflicts: { policy: 'auto', maxRounds: 2 } },
};

/** Accounts tab (T1015) with the host's accounts-state pushed after the settings state. */
function accountsVariant(id: string, cores: unknown[], opts: { skipLayout?: boolean } = {}): Variant {
  return {
    ...variant('settings', id, () => ({ messages: [...stateMessage(REALISTIC_SETTINGS).messages, { type: 'accounts-state', cores }] as never }), {
      baseline: `settings--${id}`,
      themes: ALL_THEMES,
      ...(opts.skipLayout ? { skipLayout: true } : {}),
    }),
    route: { section: 'agents', hash: formatAgentsHash({ tab: 'accounts' }) },
    ...(opts.skipLayout ? {} : { layoutRouteId: `agents${formatAgentsHash({ tab: 'accounts' })}` }),
  };
}

const DEFAULT_ONLY_CORES = ['claude', 'codex', 'opencode', 'opencode2', 'antigravity'].map((core) => ({
  core, active: 'default',
  rows: [{ name: 'default', label: 'Default (CLI home)', active: true, builtIn: true, status: 'signed-in' }],
}));

const SEVERAL_CORES = DEFAULT_ONLY_CORES.map((c) => c.core !== 'claude' ? c : {
  core: 'claude', active: 'work',
  rows: [
    { name: 'default', label: 'Default (CLI home)', active: false, builtIn: true, status: 'signed-in' },
    { name: 'work', label: 'work', active: true, builtIn: false, source: 'managed', dir: '/Users/dev/Library/Application Support/Code/User/globalStorage/karst.karst/accounts/claude/work', status: 'signed-in' },
    { name: 'claude-personal', label: 'claude-personal', active: false, builtIn: false, source: 'command', command: 'claude', dir: '/Users/dev/.claude-personal', status: 'not-signed-in' },
    { name: 'shared-team', label: 'shared-team', active: false, builtIn: false, source: 'folder', dir: '/Users/dev/team/claude', status: 'unknown' },
  ],
});

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
  ...settingsRouteVariants().filter((v) => v.baseline !== 'agents-profile' && !v.baseline.endsWith('agents-accounts')),
  accountsVariant('accounts-default-only', DEFAULT_ONLY_CORES, { skipLayout: true }),
  accountsVariant('accounts-several', SEVERAL_CORES),
  qualityStallVariant('quality-stall-disabled', { enabled: false, sameFileRounds: 3, repeatedFindingRounds: null }),
  qualityKillVariant('quality-oom-default', {}),
  qualityKillVariant('quality-oom-host', { onResourceKill: 'host' }),
  qualityKillVariant('quality-oom-disabled', { enabled: false }),
  autopilotVariant('autopilot-on', AUTOPILOT_ON),
  autopilotVariant('autopilot-invalid', { autopilot: { ...AUTOPILOT_ON.autopilot, conflicts: { policy: 'auto', maxRounds: 0 } } }, { ok: false, error: 'Invalid karst.yml: autopilot.conflicts.maxRounds must be a whole number of at least 1' }),
  qualityStallVariant('quality-stall-invalid', { enabled: true, sameFileRounds: 0, repeatedFindingRounds: 0 }),
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

/** The Queue pane is collapsed by default; the shot needs it open (view state, never posted). */
const openQueue = (corpus: () => ViewCorpus): (() => ViewCorpus) => () => ({
  ...corpus(),
  viewState: { view: { collapsed: { queue: false } } },
});

const sidebarVariants = (): Variant[] => {
  const s = fixtureCorpus.bind(null, 'sidebar', sidebarRenderFixtures as () => readonly { scenario: string; state: unknown }[]);
  return [
    variant('sidebar', 'populated', () => getCorpus('sidebar'), { baseline: 'sidebar', themes: ALL_THEMES }),
    variant('sidebar', 'empty', s('empty')),
    variant('sidebar', 'loading', LOADING),
    variant('sidebar', 'error', s('hostile')),
    variant('sidebar', 'long-content', s('multi-facet')),
    variant('sidebar', 'planning-deps', s('planning-deps')),
    variant('sidebar', 'priority', s('priority')),
    variant('sidebar', 'queue-empty', openQueue(s('empty'))),
    variant('sidebar', 'queue-populated', openQueue(s('queue'))),
    variant('sidebar', 'queue-long-content', openQueue(s('queue-long'))),
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
  const editCoreModel = () =>
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
    });
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
    // A1 (T885): edit + core+model at the widest and narrowest tiers — the actions
    // footer must never cover the settings column.
    variant('ticketForm', 'edit-core-model-tight', editCoreModel, { width: 1212 }),
    variant('ticketForm', 'edit-core-model-tight-320', editCoreModel, { width: 320 }),
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
