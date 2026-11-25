/**
 * The variant registry (ui:UI-R57, ui:VISUAL-VARIANTS): every webview in
 * WEBVIEW_NAMES maps to the variants it declares, and every variant carries
 * (a) its corpus builder, (b) the baseline name and theme projects the sweep
 * records, and (c) the layout-gate target that opens its page at every LAYOUT_WIDTHS
 * width (shared when an earlier variant opens the same page, see layoutPlan()).
 * variants.test.ts fails when any of the three is missing.
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
import { ticketRefView } from '../../src/ui/shared/ticketRefView.js';
import { INSIDE_CASES } from '../../src/ui/dashboard/insideCases.js';
import { stallFixtureState, type StallFixtureKind } from '../../src/ui/dashboard/stallFixtures.js';
import { PEEK_STATE_IDS, sidebarRenderFixtures } from '../../src/ui/sidebar/renderFixtures.js';
import type { SidebarState, TicketRow } from '../../src/ui/sidebar/state.js';
import { usageRenderFixtures } from '../../src/ui/usage/renderFixtures.js';
import { fixtureMessages, resourcesRenderFixtures, type ResourcesScenario } from '../../src/ui/resources/renderFixtures.js';
import { gettingStartedRenderFixtures } from '../../src/ui/gettingStarted/renderFixtures.js';
import { diffsRenderFixtures } from '../../src/ui/diffs/renderFixtures.js';
import { logMatchText } from '../../src/model/notifyText.js';
import { buildStageRail } from '../../src/model/stageRail.js';
import { WEBVIEW_NAMES, type WebviewName } from '../../src/model/webviewChains.js';
import { layoutWidthsFor } from '../../src/ui/layout/layoutBreakpoints.js';
import { formatAgentsHash } from '../../src/ui/settings/app/sections/agentsRoute.js';
import type { SettingsSection } from '../../src/ui/settings/sections.js';
import { settingsRoutes } from './settingsRoutes.js';
import { PANEL_TIERS, PANEL_VARIANTS } from './panelVariants.js';
import { BASELINE_VARIANTS, baselineState } from './baselineVariants.js';
import {
  CLICKUP_SETTINGS,
  DISCARD_SETTINGS,
  EMPTY_SETTINGS,
  GRAPH_SETTINGS,
  LONG_BODY_PROFILE,
  LONG_PATH_SETTINGS,
  MANUAL_SETTINGS,
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
  /**
   * Screenshot capture mode. Absent = a full-page shot. `viewport` = the visible viewport only, for a fixed overlay
   * whose full-page shot would also record the height of the page below it (@ui:VISUAL-VARIANTS).
   */
  readonly capture?: CaptureMode;
  /** Screenshot viewport height override (px): a short window puts an open popover's trigger near the bottom edge. */
  readonly viewportHeight?: number;
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
  /** Dashboard panels: a selector hovered after load and after any click. */
  readonly hover?: string;
  /** Dashboard baseline review: selectors clicked in order after load (open the overlay, then reach a state). */
  readonly clicks?: readonly string[];
  /**
   * Screenshot-only: a field filled after load (a search box), then the host messages the view expects back.
   * `replies` simulate the host's answer on the fixture page, whose `postMessage` stub has no host behind it.
   */
  readonly fill?: { readonly selector: string; readonly text: string };
  readonly replies?: readonly unknown[];
}

export type CaptureMode = 'viewport';

/** The Playwright `fullPage` option for a variant: only a `capture: 'viewport'` variant is not full-page. */
export function screenshotFullPage(v: Pick<Variant, 'capture'>): boolean {
  return v.capture !== 'viewport';
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
    capture?: CaptureMode;
    viewportHeight?: number;
    pills?: readonly string[];
    agentPopover?: AgentPopoverSteps;
    ticketDetails?: TicketDetailsSteps;
    runtimeOpen?: RuntimeOpen;
    click?: string;
    hover?: string;
    clicks?: readonly string[];
    fill?: { readonly selector: string; readonly text: string };
    replies?: readonly unknown[];
  } = {},
): Variant {
  return {
    id,
    baseline: opts.baseline ?? `${view}--${id}`,
    themes: opts.themes ?? DARK_ONLY,
    corpus,
    ...(opts.skipLayout ? { skipLayout: true } : {}),
    ...(opts.width === undefined ? {} : { width: opts.width }),
    ...(opts.capture === undefined ? {} : { capture: opts.capture }),
    ...(opts.viewportHeight === undefined ? {} : { viewportHeight: opts.viewportHeight }),
    ...(opts.pills === undefined ? {} : { pills: opts.pills }),
    ...(opts.agentPopover === undefined ? {} : { agentPopover: opts.agentPopover }),
    ...(opts.ticketDetails === undefined ? {} : { ticketDetails: opts.ticketDetails }),
    ...(opts.runtimeOpen === undefined ? {} : { runtimeOpen: opts.runtimeOpen }),
    ...(opts.click === undefined ? {} : { click: opts.click }),
    ...(opts.hover === undefined ? {} : { hover: opts.hover }),
    ...(opts.clicks === undefined ? {} : { clicks: opts.clicks }),
    ...(opts.fill === undefined ? {} : { fill: opts.fill }),
    ...(opts.replies === undefined ? {} : { replies: opts.replies }),
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
    variant('dashboard', `inside-${c.stage}-${c.id}`, () => stateMessage(c.state()), { ...(c.allThemes ? { themes: ALL_THEMES } : {}) }),
  );

/**
 * T1090: the Inside cases at the mid, narrow and tight tiers (@ui:RD-TIERS). The `width` is a screenshot field: each
 * tier variant shares the layout run of its base case, which opens the same page at every width (layoutPlan()). The
 * widths sit inside the tier they name: mid 700-999, narrow 400-699, tight <=399.
 *
 * T1352 (@ui:VISUAL-VARIANTS): only the representative responsive / long-text / overflow-prone cases record the tiers,
 * and only in `dark` — wrapping is theme-independent and an `allThemes` case's base shot already records light and hc.
 * Every other case keeps its base shot alone; `layout.layout.ts` still opens every page at every width.
 */
const INSIDE_TIERS = [['mid', 800], ['narrow', 500], ['tight', 360]] as const;
const INSIDE_TIER_CASES: ReadonlySet<string> = new Set([
  'impl-running',
  'impl-graph-long-reason',
  'impl-bounded-timeline',
  'uat-running',
  'uat-fix-parked-gate',
  'uat-gates-wait-and-run',
  'review-rounds-12',
  'review-long-attempt-note',
  'review-long-gate-detail',
  'review-long-finding-title',
  'review-multi-repo-filter',
  'ship-long-repo-names',
  'ship-autofix-header',
  'ship-deliver-auto-failed',
  'ship-auto-budget-spent',
  'done-long-text',
]);
const insideTierVariants = (): Variant[] =>
  INSIDE_CASES.filter(
    (c) => c.aliasOf === undefined && c.id !== 'live-tokens' && INSIDE_TIER_CASES.has(`${c.stage}-${c.id}`),
  ).flatMap((c) =>
    INSIDE_TIERS.map(([tier, width]) =>
      variant('dashboard', `inside-${c.stage}-${c.id}-${tier}`, () => stateMessage(c.state()), { width }),
    ),
  );

/** T1099: a viewport height above the 966px content of the ship/wide menu variant. */
const SHIP_MENU_WIDE_VIEWPORT_H = 1000;

/** T1072 (F): the stage menu open at the wide and narrow tiers, on a ship with a main action plus rest, and on a failed review. */
const stageMenuOpenVariants = (): Variant[] => {
  const cases = [
    ['ship', 'ci-failure', 'ship', (s: DashboardState): DashboardState => ({ ...s, rebase: { available: true, stage: 'ship' } })],
    ['review', 'menu-retry-send-back', 'review', (s: DashboardState): DashboardState => s],
  ] as const;
  return cases.flatMap(([stage, id, key, patch]) => {
    const c = INSIDE_CASES.find((x) => x.stage === stage && x.id === id);
    if (!c) throw new Error(`dashboard: no ${stage}/${id} inside case`);
    return ([['wide', 1100], ['narrow', 500], ['tight', 360]] as const).map(([tier, width]) =>
      variant('dashboard', `inside-${stage}-menu-open-${tier}`, () => stateMessage(patch(c.state())), {
        width,
        click: `[data-stage-menu="${key}"]`,
        // T1099: the full-page capture of ship/wide flips 964/966px while the DOM height is a stable 966px; a viewport above the content pins it.
        ...(stage === 'ship' && tier === 'wide' ? { viewportHeight: SHIP_MENU_WIDE_VIEWPORT_H } : {}),
      }),
    );
  });
};

/** T1069 (B9): the live token pill at the wide, mid and narrow tiers. */
const liveTokenVariants = (): Variant[] =>
  INSIDE_CASES.filter((c) => c.id === 'live-tokens').flatMap((c) =>
    ([['wide', 1100], ['mid', 800], ['narrow', 500], ['tight', 360]] as const).map(([tier, width]) =>
      variant('dashboard', `inside-live-tokens-${tier}`, () => stateMessage(c.state()), { width }),
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
/**
 * T1352 (@ui:VISUAL-VARIANTS): `index` keeps every tier, because its artifact pill bar wraps. The three content
 * surfaces (`env`, `logs`, `console`) record `wide` only — they add no wrapping of their own. `long-identity` keeps
 * every tier too, from its own tier map below.
 */
const DRILL_MULTI_WIDTH_SURFACES: ReadonlySet<string> = new Set(['index']);
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

/** Every `index` tier, the long identity at every tier, and one wide shot per content surface. */
const drillDownVariants = (): Variant[] => [
  ...DRILL_SURFACES.flatMap(([surface, pills]) =>
    (DRILL_MULTI_WIDTH_SURFACES.has(surface) ? DRILL_TIERS : DRILL_TIERS.slice(0, 1)).map(([tier, width]) =>
      variant('dashboard', `drill-${surface}-${tier}`, drillCorpus(withConsoles), { width, pills, skipLayout: true }),
    ),
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

/**
 * T1060: the four states x their tabs. The drawer is a fixed overlay: no layout run of its own, and the shot is the
 * viewport, not the page below it. T1352 (@ui:VISUAL-VARIANTS): only the two overflow-prone `rich` tabs (structured
 * metadata and raw markdown with unbroken URLs) record `mid` and `narrow`; the other six state x tab pairs record `wide`.
 */
const ticketDetailsVariants = (): Variant[] =>
  DETAILS_STATES.flatMap(([name, patch]) =>
    (DETAILS_TABS[name] ?? []).flatMap((tab) => {
      const tiers = name === 'rich' && (tab === undefined || tab === 'raw') ? DETAILS_TIERS : DETAILS_TIERS.slice(0, 1);
      return tiers.map(([tier, width]) =>
        variant('dashboard', `ticket-details-${name}${tab ? `-${tab}` : ''}-${tier}`, dashboardScenario('running', 2, patch), {
          skipLayout: true,
          width,
          capture: 'viewport',
          ticketDetails: tab ? { tab } : {},
        }),
      );
    }),
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

/**
 * The runtime strip, one scenario per state. T1352 (@ui:VISUAL-VARIANTS): every state records `wide`; only the full
 * strip and the long wrapping note also record `mid` and `narrow`. Both open popovers keep every tier.
 */
const RUNTIME_MULTI_WIDTH: ReadonlySet<string> = new Set(['docker', 'host-note']);

const runtimeStripVariants = (): Variant[] => [
  ...RUNTIME_STATES.flatMap(([id, patch]) =>
    (RUNTIME_MULTI_WIDTH.has(id) ? RUNTIME_TIERS : RUNTIME_TIERS.slice(0, 1)).map(([tier, width]) =>
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

/**
 * T1063: every Servers / Worktrees / Pull requests state at `wide`, plus the `mid` and `narrow` tiers of a
 * representative `multiWidth` state, and the narrow sub-task row (@ui:VISUAL-VARIANTS, T1352).
 */
const panelStateVariants = (): Variant[] => [
  ...PANEL_VARIANTS.flatMap((v) =>
    (v.multiWidth === true ? PANEL_TIERS : PANEL_TIERS.slice(0, 1)).map(([tier, width]) =>
      variant('dashboard', `panel-${v.id}-${tier}`, dashboardScenario('running', 2, v.patch), {
        skipLayout: true,
        width,
        ...(v.click === undefined ? {} : { click: v.click }),
        ...(v.hover === undefined ? {} : { hover: v.hover }),
      }),
    ),
  ),
  variant('dashboard', 'subtask-narrow', dashboardScenario('running', 2), { skipLayout: true, width: 400 }),
  ...bottomEdgeVariants(),
  ...dashboardBottomEdgeVariants(),
  ...layoutVariants(),
];

/** T1183: the "..." menu open with each page-width mode selected, at a wide window where the two modes differ. */
const LAYOUT_VARIANT_WIDTH = 1800;
const layoutVariants = (): Variant[] =>
  (['centered', 'full'] as const).map((layout) =>
    variant('dashboard', `layout-${layout}-menu-open`, () => {
      const base = dashboardScenario('running', 2)();
      return { ...base, messages: [...base.messages, { type: 'layout', layout }] };
    }, {
      skipLayout: true,
      width: LAYOUT_VARIANT_WIDTH,
      click: '[aria-label="Ticket controls"]',
    }),
  );

/** T1091: an open popover whose trigger sits at the bottom edge of a short window flips above it and stays inside the gutter. */
const BOTTOM_EDGE_HEIGHT = 480;
const bottomEdgeVariants = (): Variant[] =>
  PANEL_VARIANTS.filter((v) => ['pr-ready-info', 'wt-base'].includes(v.id)).map((v) =>
    variant('dashboard', `panel-${v.id}-bottom-edge`, dashboardScenario('running', 2, v.patch), {
      skipLayout: true,
      width: 800,
      viewportHeight: BOTTOM_EDGE_HEIGHT,
      ...(v.click === undefined ? {} : { click: v.click }),
    }),
  );

/** T1091: the runtime strip menus, the ticket menu and the stage menu near the bottom edge of a short window. */
const dashboardBottomEdgeVariants = (): Variant[] => [
  ...(['sandbox', 'more'] as const).map((open) =>
    variant('dashboard', `runtime-${open}-open-bottom-edge`, dashboardScenario('running', 2, (s) => ({ ...s, sandbox: SBX_VIEW })), {
      skipLayout: true,
      width: 800,
      viewportHeight: BOTTOM_EDGE_HEIGHT,
      runtimeOpen: open,
    }),
  ),
  variant('dashboard', 'ticket-menu-bottom-edge', dashboardScenario('running', 2), {
    skipLayout: true,
    width: 800,
    viewportHeight: BOTTOM_EDGE_HEIGHT,
    click: '[aria-label="Ticket controls"]',
  }),
  variant(
    'dashboard',
    'stage-menu-bottom-edge',
    () => {
      const c = INSIDE_CASES.find((x) => x.stage === 'review' && x.id === 'menu-retry-send-back');
      if (!c) throw new Error('dashboard: no review/menu-retry-send-back inside case');
      return stateMessage(c.state());
    },
    { skipLayout: true, width: 800, viewportHeight: BOTTOM_EDGE_HEIGHT, click: '[data-stage-menu="review"]' },
  ),
];

/** T1071: the baseline review banner and overlay (ui:UI-R39), layout checks on. */
const baselineReviewVariants = (): Variant[] =>
  BASELINE_VARIANTS.map((v) =>
    variant('dashboard', `baseline-${v.id}`, () => stateMessage(baselineState(v.rows())), {
      clicks: v.clicks,
      // The banner states sit on the full dashboard, whose rail and title already fail the layout gate at its ledgered
      // routes; a new route cannot inherit them (the ledger takes no new entry). The overlay states replace the page.
      ...(v.clicks.length === 0 ? { skipLayout: true } : {}),
      ...(v.width === undefined ? {} : { width: v.width }),
    }),
  );

/** T1099: the one stage chip at a full-word host (460px) and a short-word host (300px), in both themes (@ui:11.21). */
const CHIP_TIERS = [['460', 460], ['300', 300]] as const;
const CHIP_THEMES: readonly string[] = ['dark', 'light'];

const chipBlockers = (s: DashboardState): DashboardState => ({
  ...s,
  blockers: [
    ticketRefView({ ticket: { id: 42, key: 'CU-123', stageCurrent: 'impl', stages: [] } as never }),
    ticketRefView({ ticket: { id: 43, key: 'CU-124', stageCurrent: 'review', stages: [] } as never }),
    ticketRefView({ ref: 'external' }),
  ],
});

/** T1346: all four Overview panels with nothing to list; Sub-tasks can still gain one and Servers is runnable. */
const emptyPanels = (s: DashboardState): DashboardState => ({
  ...s,
  subtasks: [],
  subtaskProgress: { done: 0, total: 0 },
  canAddSubtask: true,
  hasRunnableRepos: true,
  servers: [],
  sharedServers: [],
  worktrees: [],
  prs: [],
});

const dashboardVariants = (): Variant[] => [
  ...CHIP_TIERS.map(([tier, width]) =>
    variant('dashboard', `stage-chip-${tier}`, dashboardScenario('running', 2, chipBlockers), { width, themes: CHIP_THEMES }),
  ),
  variant('dashboard', 'populated', dashboardScenario('running', 10), { baseline: 'dashboard-running', themes: ALL_THEMES }),
  ...(['pending', 'passed', 'failed', 'waiting', 'exhausted'] as const).map((s) =>
    variant('dashboard', s, dashboardScenario(s, 10), { baseline: `dashboard-${s}`, themes: ALL_THEMES }),
  ),
  ...stallVariants(),
  variant('dashboard', 'empty', () => stateMessage(renderStateFor('scope'))),
  // T1346 Q3 (UI-R46): all four Overview panels empty at once — one muted line each, header actions kept, and no
  // panel losing its place. The layout gate opens this page at every width; the tight shot (320-399 tier, RD-TIERS)
  // shares that run, because a differing `width` is not a different page.
  variant('dashboard', 'empty-panels', dashboardScenario('running', 2, emptyPanels)),
  variant('dashboard', 'empty-panels-tight', dashboardScenario('running', 2, emptyPanels), { width: 360 }),
  variant('dashboard', 'loading', LOADING),
  variant('dashboard', 'error', dashboardScenario('failed', 2)),
  variant('dashboard', 'long-content', dashboardScenario('running', 20, (s) => ({ ...s, title: LONG_TITLE }))),
  variant('dashboard', 'confirm-ship', () => stateMessage(shipPreviewStateFor('ready'))),
  variant('dashboard', 'ship-blocked', () => stateMessage(shipPreviewStateFor('blocked'))),
  variant('dashboard', 'ship-error', () => stateMessage(shipPreviewStateFor('error'))),
  // D159: a quota block is non-resumable; its banner carries Pick/Retry/Dismiss and the rail mirrors "Pick another model".
  variant('dashboard', 'usage-limit-blocked', dashboardScenario('running', 2, (s) => {
    const blocked = { kind: 'usage-limit' as const, reason: 'anthropic: monthly quota exceeded', at: '2026-01-01T00:00:00.000Z', resumable: false };
    const stepper = s.stepper.map((c) =>
      c.stageKey === 'impl' || c.stageKey === 'uat'
        ? { ...c, status: 'passed' as const }
        : c.stageKey === 'review'
          ? { ...c, status: 'running' as const, blocked }
          : c,
    );
    return {
      ...s,
      stageCurrent: 'review',
      currentStage: { stageKey: 'review', status: 'running', blocked },
      stepper,
      rail: buildStageRail(stepper, stepper, {
        current: 'review',
        needsUser: true,
        needs: { detail: 'the provider is out of quota', action: 'Pick another model', cta: { kind: 'usage-limit-pick' } },
      }),
    };
  })),
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
  // T1266: a graph ticket's header names expert / worker / fast, the approach fallback included.
  variant('dashboard', 'graph-header', dashboardScenario('running', 2, (s) => ({
    ...s,
    capabilityIdentity: {
      ...s.capabilityIdentity,
      graphExpert: { provider: 'claude', model: 'claude-opus-5', effort: 'high' },
      graphWorker: { provider: 'claude', model: 'claude-sonnet-5', effort: 'low' },
      graphFast: { provider: 'claude', model: 'claude-sonnet-5', effort: 'low' },
    },
  })), { themes: ['dark', 'light'], skipLayout: true }),
  ...runtimeStripVariants(),
  ...panelStateVariants(),
  // D203: the Servers panel's read-only shared half — one running from the base
  // branch, one stopped — beside the ticket's own rows.
  variant('dashboard', 'shared-services', dashboardScenario('running', 2, (s) => ({
    ...s,
    sharedServers: sharedServerFixtures(),
  }))),
  ...insideCaseVariants(),
  ...insideTierVariants(),
  ...stageMenuOpenVariants(),
  ...liveTokenVariants(),
  ...agentPopoverVariants(),
  ...ticketDetailsVariants(),
  ...baselineReviewVariants(),
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
  [`agents${formatAgentsHash({ tab: 'sandbox' })}`]: 'agents-sandbox',
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
        // T1297 SET-63: light and HC capture every Settings route, not only the legacy four.
        themes: ALL_THEMES,
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

/**
 * Autopilot route in one state: off is the default `route-autopilot`; on and a host fault are these (T1004).
 * The fault rides `SettingsState.error`, the only field the app reads for it (T1086).
 */
function autopilotVariant(
  id: string,
  over: Record<string, unknown>,
  opts: { error?: string; width?: number } = {},
): Variant {
  const manifest = { ...REALISTIC_SETTINGS.manifest, ...over };
  return {
    ...variant('settings', id, () => stateMessage({ ...REALISTIC_SETTINGS, manifest, error: opts.error ?? null }), {
      baseline: `settings--${id}`,
      themes: ALL_THEMES,
      // Layout ids are unique per route: `route-autopilot` already runs the autopilot layout at 1280, 699 and 480.
      skipLayout: true,
      ...(opts.width === undefined ? {} : { width: opts.width }),
    }),
    route: { section: 'autopilot' },
  };
}

/** T1236: the section nav as one wrapping chip row below 40em, on general, agents roles and autopilot (@ui:RD-TIERS). */
const NAV_NARROW_TIERS = [['narrow', 630], ['tight', 320]] as const;
const NAV_NARROW_ROUTES = [
  ['general', { section: 'general' }],
  ['agents', { section: 'agents', hash: formatAgentsHash({ tab: 'roles' }) }],
  ['autopilot', { section: 'autopilot' }],
] as const;

const navNarrowVariants = (): Variant[] =>
  NAV_NARROW_ROUTES.flatMap(([name, route]) =>
    NAV_NARROW_TIERS.map(([tier, width]) => {
      const id = `nav-${name}-${tier}`;
      return {
        ...variant('settings', id, () => stateMessage(REALISTIC_SETTINGS), {
          baseline: `settings--${id}`,
          themes: DARK_ONLY,
          // The route layout run already covers these routes; this variant records the nav shot only.
          skipLayout: true,
          width,
        }),
        route,
      };
    }),
  );

/** T1239: the roles summary rows below 700 px — all collapsed, one row opened by the route, and at 320 px (@ui:UI-R57). */
const ROLES_NARROW = [
  ['roles-narrow-collapsed', 630, { tab: 'roles' }],
  ['roles-narrow-expanded', 630, { tab: 'roles', selected: 'uatTester' }],
  ['roles-tight-collapsed', 320, { tab: 'roles' }],
] as const;

const rolesNarrowVariants = (): Variant[] =>
  ROLES_NARROW.map(([id, width, route]) => ({
    ...variant('settings', id, () => stateMessage(REALISTIC_SETTINGS), {
      baseline: `settings--${id}`,
      themes: DARK_ONLY,
      // The route layout runs already cover the roles route at every width.
      skipLayout: true,
      width,
    }),
    route: { section: 'agents', hash: formatAgentsHash(route) },
  }));

/** T1266: the graph role rows (approach fallback + a slot) at the wide, mid-narrow and tight tiers (@ui:UI-R57). */
const ROLES_GRAPH = [
  ['roles-graph', 1100, { tab: 'roles', selected: 'graphExpert' }],
  ['roles-graph-narrow', 630, { tab: 'roles', selected: 'graphExpert' }],
  ['roles-graph-tight', 320, { tab: 'roles' }],
] as const;

const rolesGraphVariants = (): Variant[] =>
  ROLES_GRAPH.map(([id, width, route]) => ({
    ...variant('settings', id, () => stateMessage(REALISTIC_SETTINGS), {
      baseline: `settings--${id}`,
      themes: DARK_ONLY,
      skipLayout: true,
      width,
    }),
    route: { section: 'agents', hash: formatAgentsHash(route) },
  }));

/** T1297 SET-26: the graph approach card at the wide, mid and narrow tiers (@ui:UI-R57). */
const APPROACHES_GRAPH = [
  ['approaches-graph', 1100],
  ['approaches-graph-mid', 800],
  ['approaches-graph-narrow', 630],
] as const;

const approachesGraphVariants = (): Variant[] =>
  APPROACHES_GRAPH.map(([id, width]) => ({
    ...variant('settings', id, () => stateMessage(GRAPH_SETTINGS), {
      baseline: `settings--${id}`,
      themes: DARK_ONLY,
      // The approaches route layout run already covers the page at every width.
      skipLayout: true,
      width,
    }),
    route: { section: 'approaches' },
  }));

const AUTOPILOT_FAULT = 'Invalid karst.yml: autopilot.conflicts.maxRounds must be a whole number of at least 1';
const AUTOPILOT_TIERS = [['mid', 800], ['narrow', 480]] as const;
const MANY_CHECKS = ['lint', 'typecheck', 'test:unit', 'test:integration', 'test:e2e', 'build', 'docs-gate', 'docs-graph', 'mutation-score', 'visual-regression', 'layout-sanity', 'a-very-long-check-name-for-wrapping'];

const AUTOPILOT_ON = {
  autopilot: { enabled: true, ci: { policy: 'auto', maxAttempts: 3, checks: ['lint', 'typecheck'] }, conflicts: { policy: 'auto', maxRounds: 2 } },
};

const autopilotVariants = (): Variant[] => {
  const invalid = { autopilot: { ...AUTOPILOT_ON.autopilot, conflicts: { policy: 'auto', maxRounds: 0 } } };
  return [
    autopilotVariant('autopilot-on', AUTOPILOT_ON),
    autopilotVariant('autopilot-invalid', invalid, { error: AUTOPILOT_FAULT }),
    autopilotVariant('autopilot-long-content', { autopilot: { ...AUTOPILOT_ON.autopilot, ci: { ...AUTOPILOT_ON.autopilot.ci, checks: MANY_CHECKS } } }),
    ...AUTOPILOT_TIERS.flatMap(([tier, width]) => [
      autopilotVariant(`autopilot-on-${tier}`, AUTOPILOT_ON, { width }),
      autopilotVariant(`autopilot-invalid-${tier}`, invalid, { error: AUTOPILOT_FAULT, width }),
    ]),
  ];
};

/** Accounts tab (T1015) with the host's accounts-state pushed after the settings state. */
function accountsVariant(
  id: string,
  cores: unknown[],
  opts: { skipLayout?: boolean; settings?: typeof REALISTIC_SETTINGS; themes?: readonly string[]; width?: number } = {},
): Variant {
  return {
    ...variant('settings', id, () => ({ messages: [...stateMessage(opts.settings ?? REALISTIC_SETTINGS).messages, { type: 'accounts-state', cores }] as never }), {
      baseline: `settings--${id}`,
      themes: opts.themes ?? ALL_THEMES,
      ...(opts.skipLayout ? { skipLayout: true } : {}),
      ...(opts.width === undefined ? {} : { width: opts.width }),
    }),
    route: { section: 'agents', hash: formatAgentsHash({ tab: 'accounts' }) },
    ...(opts.skipLayout ? {} : { layoutRouteId: `agents${formatAgentsHash({ tab: 'accounts' })}` }),
  };
}

const DEFAULT_ONLY_CORES = ['claude', 'codex', 'opencode', 'opencode2', 'antigravity'].map((core) => ({
  core, active: 'default', machineDefault: 'default', source: 'machine',
  rows: [{ name: 'default', label: 'Default (CLI home)', active: true, builtIn: true, status: 'signed-in' }],
}));

const SEVERAL_CORES = DEFAULT_ONLY_CORES.map((c) => c.core !== 'claude' ? c : {
  core: 'claude', active: 'work', machineDefault: 'default', source: 'project', // T1244: this project chose `work`
  rows: [
    { name: 'default', label: 'Default (CLI home)', active: false, builtIn: true, status: 'signed-in' },
    { name: 'work', label: 'work', active: true, builtIn: false, source: 'managed', dir: '/Users/dev/Library/Application Support/Code/User/globalStorage/karst.karst/accounts/claude/work', status: 'signed-in' },
    { name: 'claude-personal', label: 'claude-personal', active: false, builtIn: false, source: 'command', command: 'claude', dir: '/Users/dev/.claude-personal', status: 'not-signed-in' },
    { name: 'shared-team', label: 'shared-team', active: false, builtIn: false, source: 'folder', dir: '/Users/dev/team/claude', status: 'unknown' },
  ],
});

// D651: a Claude account row with and without an sbx token. Deviation from the Agents prototype (UI-R39-REJECT): it has no token column.
const TOKEN_CORES = SEVERAL_CORES.map((c) => c.core !== 'claude' ? c : {
  ...c,
  rows: c.rows.map((r) => r.name === 'work' ? { ...r, sbxToken: 'set' } : r.name === 'shared-team' ? { ...r, sbxToken: 'not-set' } : r),
});

// T1360: the row states the flat accounts table must carry in one screen — a not-signed-in active account (warning
// dot + inline Log in), a managed account with no folder ("Managed"), a command account, and every sbx token state
// (`set`, `not-set`, `unknown`). One single-account core stays beside it, so the table has two cores.
const ROW_STATE_CORES = [
  {
    core: 'claude', active: 'team', machineDefault: 'default', source: 'project',
    rows: [
      { name: 'default', label: 'Default (CLI home)', active: false, builtIn: true, status: 'signed-in' },
      { name: 'team', label: 'team', active: true, builtIn: false, source: 'managed', status: 'not-signed-in', sbxToken: 'set' },
      { name: 'claude-personal', label: 'claude-personal', active: false, builtIn: false, source: 'command', command: 'claude-personal --profile work', dir: '/Users/dev/.claude-personal', status: 'unknown', sbxToken: 'not-set' },
      { name: 'consulting', label: 'consulting', active: false, builtIn: false, source: 'folder', dir: '/Users/dev/consulting/claude', status: 'signed-in', sbxToken: 'unknown' },
    ],
  },
  {
    core: 'codex', active: 'default', machineDefault: 'default', source: 'machine',
    rows: [{ name: 'default', label: 'Default (CLI home)', active: true, builtIn: true, status: 'signed-in' }],
  },
];

// T1360 review: the Account cell must break one long unbroken name instead of
// pushing the row past its track (UI-R44); the name is a valid 50-char slug.
const LONG_NAME_CORES = [{
  core: 'claude', active: 'default', machineDefault: 'default', source: 'machine',
  rows: [
    { name: 'default', label: 'Default (CLI home)', active: true, builtIn: true, status: 'signed-in' },
    {
      name: 'claude-max-subscription-account-berlin-office-2026',
      label: 'claude-max-subscription-account-berlin-office-2026',
      active: false, builtIn: false, source: 'managed', status: 'signed-in',
    },
  ],
}];

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
  // Backend check error: sbx selected for claude, the host reports it not signed in.
  {
    ...variant(
      'settings',
      'agents-sandbox-error',
      () => ({
        messages: [
          ...stateMessage({
            ...REALISTIC_SETTINGS,
            manifest: { ...REALISTIC_SETTINGS.manifest, agentBackends: { claude: 'sbx' } },
          }).messages,
          { type: 'backend-status', status: { sbx: { ok: false, reason: 'sbx not signed in (run `sbx login`)' }, docker: { ok: true } } },
        ] as never,
      }),
      { baseline: 'settings--agents-sandbox-error', themes: DARK_ONLY, skipLayout: true },
    ),
    route: { section: 'agents', hash: formatAgentsHash({ tab: 'sandbox' }) },
  },
  accountsVariant('accounts-default-only', DEFAULT_ONLY_CORES, { skipLayout: true }),
  accountsVariant('accounts-several', SEVERAL_CORES),
  accountsVariant('accounts-sbx-token', TOKEN_CORES, { skipLayout: true }),
  // T1360: the flat table's row states in one shot. skipLayout, because `accounts-several` already runs this route at
  // every SETTINGS_LAYOUT_WIDTHS width.
  accountsVariant('accounts-not-signed-in', ROW_STATE_CORES, { skipLayout: true, themes: DARK_ONLY }),
  // T1360: the stacked core cards under the 699px container tier (@ui:UI-R43, @ui:UI-R55). skipLayout, as above.
  accountsVariant('accounts-narrow', SEVERAL_CORES, { skipLayout: true, themes: DARK_ONLY, width: 480 }),
  // T1360 review: one 50-char unbroken account name, the UI-R44 wrapping case.
  accountsVariant('accounts-long-name', LONG_NAME_CORES, { skipLayout: true, themes: DARK_ONLY }),
  // D707: the Subscription quota card with a saved threshold and both opt-ins on; one core, so the card is inside the 720 px viewport.
  accountsVariant('accounts-quota', DEFAULT_ONLY_CORES.slice(0, 1), {
    skipLayout: true,
    settings: { ...REALISTIC_SETTINGS, manifest: { ...REALISTIC_SETTINGS.manifest, quota: { warnThresholdPct: 90, claudeGlobalStatusline: true, claudeOauthUsageApi: true } } } as typeof REALISTIC_SETTINGS,
  }),
  qualityStallVariant('quality-stall-disabled', { enabled: false, sameFileRounds: 3, repeatedFindingRounds: null }),
  qualityKillVariant('quality-oom-default', {}),
  qualityKillVariant('quality-oom-host', { onResourceKill: 'host' }),
  qualityKillVariant('quality-oom-disabled', { enabled: false }),
  ...autopilotVariants(),
  ...navNarrowVariants(),
  ...rolesNarrowVariants(),
  ...rolesGraphVariants(),
  ...approachesGraphVariants(),
  // T1297 Q11: the General tab discarded at once, with the 5 s "Changes discarded · Undo" offer. One
  // click toggles a saved checkbox (the Discard button is disabled while clean), the second discards it.
  {
    ...variant('settings', 'discard-undo', () => stateMessage(DISCARD_SETTINGS), {
      themes: DARK_ONLY,
      skipLayout: true,
      clicks: ['#section-general input[name="diffsInSourceControl"]', '#discardBtn'],
    }),
    route: { section: 'general' },
  },
  // T1297 SET-28: a manual board renders no ClickUp connection fields.
  {
    ...variant('settings', 'ticketing-manual', () => stateMessage(MANUAL_SETTINGS), {
      themes: DARK_ONLY,
      skipLayout: true,
    }),
    route: { section: 'ticketing' },
  },
  // T1297 SET-29: a saved ClickUp board with its list in the host's reply; one toggle makes the topbar dirty.
  {
    ...variant('settings', 'ticketing-clickup', () => stateMessage(CLICKUP_SETTINGS), {
      themes: DARK_ONLY,
      skipLayout: true,
      click: 'input[name="searchEnabled"]',
      replies: [{ type: 'ticket-lists', lists: [{ id: '901', name: 'Sprint 41', space: 'Engineering' }] }],
    }),
    route: { section: 'ticketing' },
  },
  // T1297 SET-25: a 120-character repository path in its middle-ellipsis form (@ui:UI-R44).
  {
    ...variant('settings', 'repositories-long-path', () => stateMessage(LONG_PATH_SETTINGS), {
      themes: DARK_ONLY,
      skipLayout: true,
    }),
    route: { section: 'services' },
  },
  // T1297 SET-39: no presets, so the Roles tab reads "None".
  {
    ...variant('settings', 'roles-no-presets', () => stateMessage(EMPTY_SETTINGS), {
      themes: DARK_ONLY,
      skipLayout: true,
    }),
    route: { section: 'agents', hash: formatAgentsHash({ tab: 'roles' }) },
  },
  // T1297 SET-36: the Roles rows at the 700-999 px mid tier (1000 px viewport minus the sidebar).
  {
    ...variant('settings', 'roles-mid', () => stateMessage(REALISTIC_SETTINGS), {
      themes: DARK_ONLY,
      skipLayout: true,
      width: 1000,
    }),
    route: { section: 'agents', hash: formatAgentsHash({ tab: 'roles' }) },
  },
  qualityStallVariant('quality-stall-invalid', { enabled: true, sameFileRounds: 0, repeatedFindingRounds: 0 }),
  // T1091: the provider select near the bottom edge of a short window.
  {
    ...variant('settings', 'provider-menu-bottom-edge', () => stateMessage(REALISTIC_SETTINGS), {
      skipLayout: true,
      width: 800,
      viewportHeight: BOTTOM_EDGE_HEIGHT,
      click: '#provSelectWrap .provselect-trigger',
    }),
    route: { section: 'ticketing' },
  },
];

// ----------------------------------------------------------------- others

const serverLogsVariants = (): Variant[] => {
  const entry = (service: string, content: string, extra: { truncated?: boolean; state?: 'ok' | 'empty' | 'no-path' | 'unreadable'; message?: string } = {}) => ({
    service, logPath: `/tmp/${service}.log`, truncated: false, content, ...extra,
  });
  const logs = (...servers: ReturnType<typeof entry>[]): ViewCorpus => ({ messages: [{ type: 'server-logs', servers }] });
  const line = (n: number) => `2026-01-01T00:00:${String(n % 60).padStart(2, '0')}.000Z GET /health ${'x'.repeat(n % 7)} 200 3ms\n`;
  return [
    variant('serverLogs', 'populated', () => getCorpus('serverLogs'), { baseline: 'serverLogs', themes: ALL_THEMES }),
    // T1298: one search hit. The fixture host answers the count with `logMatchText(1)` (the page has no host behind postMessage).
    variant('serverLogs', 'search-one-match', () => getCorpus('serverLogs'), {
      skipLayout: true,
      fill: { selector: '#logsSearch', text: 'timeout' },
      replies: [{ type: 'server-logs-match-text', seq: 1, text: logMatchText(1) }],
    }),
    variant('serverLogs', 'empty', () => logs()),
    variant('serverLogs', 'loading', LOADING),
    variant('serverLogs', 'error', () => logs(entry('api', '2026-01-01T00:00:00.000Z \u001b[31merror\u001b[0m ECONNREFUSED 127.0.0.1:5432\n'))),
    variant('serverLogs', 'long-content', () =>
      logs(
        entry('web-frontend-with-a-very-long-service-name-over-forty-chars', `2026-01-01T00:00:00.000Z ${'GET /very/long/path/segment/'.repeat(30)} 200\n`),
        entry('api', Array.from({ length: 400 }, (_, i) => line(i)).join('')),
      ),
    ),
    // T1317 LG-11: the same hostile line with Wrap off, so it scrolls inside the log host only (@ui:UI-R45).
    variant('serverLogs', 'long-content-nowrap', () =>
      logs(
        entry('web-frontend-with-a-very-long-service-name-over-forty-chars', `2026-01-01T00:00:00.000Z ${'GET /very/long/path/segment/'.repeat(30)} 200\n`),
        entry('api', Array.from({ length: 400 }, (_, i) => line(i)).join('')),
      ),
      { click: '[data-log-wrap]' },
    ),
    // T1317 LG-1: a log over the read cap opens at its newest output, with the skipped part named first.
    variant('serverLogs', 'truncated', () =>
      logs(entry('api', '[Earlier output not shown: 14.2 MB]\n' + Array.from({ length: 40 }, (_, i) => line(i)).join(''), { truncated: true })),
    ),
    // T1317 LG-8: no service at all, and a service whose log karst cannot read.
    variant('serverLogs', 'no-services', () => ({ messages: [{ type: 'server-logs', servers: [] }] })),
    variant('serverLogs', 'unreadable', () =>
      logs(entry('api', '', { state: 'unreadable', message: 'Karst cannot read /tmp/api.log.' })),
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

/** The Activity pane is collapsed by default; the shot needs it open (view state, never posted). */
const openActivity = (corpus: () => ViewCorpus): (() => ViewCorpus) => () => ({
  ...corpus(),
  viewState: { view: { collapsed: { activity: false } } },
});

/**
 * SB-3 (T1318): a sidebar webview is about 300 px wide in a split editor group, so every sidebar shot records
 * that width; a tier variant names 320 or 460 px (@ui:RD-TIERS).
 */
const SIDEBAR_WIDTH = 300;
/** The three host tiers: the floor, the tight-tier step and the narrow tier (@ui:RD-TIERS). */
const SIDEBAR_TIERS = [['300', 300], ['320', 320], ['460', 460]] as const;
/** Every tier theme (@ui:UI-R57): dark, light and high contrast. */
const SIDEBAR_TIER_THEMES: readonly string[] = ALL_THEMES;
/** The state SHAPES also record the grayscale and reduced-motion projects (@ui:UI-R28, UI-R30). */
const SIDEBAR_SHAPE_THEMES: readonly string[] = ['dark', 'dark-grayscale', 'dark-reduced-motion'];

type VariantOpts = NonNullable<Parameters<typeof variant>[3]>;

/** One sidebar variant at the real host width; a tier variant passes its own `width` (SB-3). */
const sidebarVariant = (id: string, corpus: () => ViewCorpus, opts: VariantOpts = {}): Variant =>
  variant('sidebar', id, corpus, { width: SIDEBAR_WIDTH, ...opts });

/** SB-3 (T1318): the long-content page carries the 100-character ticket title in its first row and its peek. */
const withLongTitle = (corpus: () => ViewCorpus): (() => ViewCorpus) => () => {
  const c = corpus();
  const msg = c.messages[0] as { type?: string; state?: SidebarState } | undefined;
  if (msg?.type !== 'state' || msg.state === undefined) return c;
  const rename = (row: TicketRow, index: number): TicketRow =>
    index === 0 ? { ...row, label: LONG_TITLE, peek: { ...row.peek, title: LONG_TITLE } } : row;
  const state = msg.state;
  return {
    ...c,
    messages: [
      {
        ...msg,
        state: {
          ...state,
          rows: state.rows.map(rename),
          sections: {
            current: state.sections.current.map(rename),
            awaitingReview: state.sections.awaitingReview.map(rename),
            recentlyDone: state.sections.recentlyDone.map(rename),
            olderDone: state.sections.olderDone.map(rename),
          },
        },
      },
    ],
  };
};

/** T1312: a Planning session starts collapsed; a draft-row shot opens its session first (view state, never posted). */
const openPlan = (sessionId: number): readonly string[] => [`.pt-twistie[data-plan-toggle="${sessionId}"]`];

const sidebarVariants = (): Variant[] => {
  const s = fixtureCorpus.bind(null, 'sidebar', sidebarRenderFixtures as () => readonly { scenario: string; state: unknown }[]);
  /** One tier family: the same page at 300, 320 and 460 px in dark, light and hc (@ui:RD-TIERS). */
  const tiers = (id: string, corpus: () => ViewCorpus, opts: VariantOpts = {}): Variant[] =>
    SIDEBAR_TIERS.map(([tier, width]) => sidebarVariant(`${id}-${tier}`, corpus, { ...opts, width, themes: SIDEBAR_TIER_THEMES }));
  /** The peek rows open by their chevron; the shared `clicks` make the widths share one layout run. */
  const peekClicks = PEEK_STATE_IDS.map((id) => `[data-id="${id}"] .chev`);
  return [
    // The mandatory ids keep their names; every shot is the real 300 px host width (baseline `sidebar.png` kept).
    sidebarVariant('populated', () => getCorpus('sidebar'), { baseline: 'sidebar', themes: ALL_THEMES }),
    // SB-3: the 15 real titles and the Activity rows of the probe, with Activity open (its three-row floor is checked).
    sidebarVariant('populated-300', openActivity(s('real-titles'))),
    // T1298: the attention line at one input and one failed ("1 needs you · 1 failed"); the same state all-sections carries.
    variant('sidebar', 'attention-one', s('all-sections'), { width: SIDEBAR_WIDTH, skipLayout: true }),
    sidebarVariant('empty', s('empty')),
    sidebarVariant('loading', LOADING),
    sidebarVariant('error', s('hostile'), { clicks: openPlan(91) }),
    // SB-2: the host build throws: the error line above the panes, and the pane skeleton below, never an empty list.
    sidebarVariant('host-error', LOADING, { replies: [{ type: 'error', message: 'fixture: the ticket store could not be read' }] }),
    sidebarVariant('long-content', withLongTitle(s('multi-facet'))),
    sidebarVariant('planning-deps', s('planning-deps'), { clicks: openPlan(17) }),
    sidebarVariant('priority', s('priority'), { clicks: openPlan(17) }),
    sidebarVariant('queue-empty', openQueue(s('empty'))),
    sidebarVariant('queue-populated', openQueue(s('queue'))),
    sidebarVariant('queue-long-content', openQueue(s('queue-long'))),
    // RD-1: the open Queue at every tier: the relation wraps, the row never scrolls sideways (@ui:UI-R43).
    ...tiers('queue-chips', openQueue(s('queue'))),
    sidebarVariant('activity-empty', openActivity(s('empty'))),
    sidebarVariant('activity-populated', openActivity(s('activity'))),
    sidebarVariant('activity-long-content', openActivity(s('activity-long'))),
    ...tiers('activity', openActivity(s('activity'))),
    sidebarVariant('subtasks', s('subtasks')),
    // SB-5: the stage pill reads the short key at 300/320 and the full word at 460 (@ui:UI-R49, UI-R51).
    ...tiers('stage-chip', s('planning-deps'), { clicks: openPlan(17) }),
    ...tiers('waits-on', s('waits-on')),
    ...tiers('planning-artifacts', s('planning-artifacts'), { hover: '[data-node="s95"] .pt-row' }),
    // UI-R28/UI-R28b: every state family's expanded row with its shape, at the floor, the tight step and the full word.
    sidebarVariant('peek-states-300', s('peek-states'), { width: 300, clicks: peekClicks, themes: SIDEBAR_SHAPE_THEMES }),
    sidebarVariant('peek-states-320', s('peek-states'), { width: 320, clicks: peekClicks }),
    sidebarVariant('peek-states-460', s('peek-states'), { width: 460, clicks: peekClicks }),
    // RD-4/RD-5: the two stage blocks as the peek headline; RD-3: a closed pull request.
    sidebarVariant('peek-blocked-300', s('peek-blocked'), { clicks: ['[data-id="900008"] .chev', '[data-id="900006"] .chev'] }),
    sidebarVariant('peek-pr-closed-300', s('peek-pr-closed'), { clicks: ['[data-id="900013"] .chev'] }),
    // SB-9: the filter state on screen; SB-8: a hovered row keeps its full stage and its title length.
    sidebarVariant('filtered-300', s('filtered')),
    sidebarVariant('row-hover-300', () => getCorpus('sidebar'), { hover: '[data-id="900001"] .row' }),
    sidebarVariant('cloud-sessions', s('cloud-sessions')),
    // T1091: the filter menu in a short window.
    sidebarVariant('filter-menu-bottom-edge', () => getCorpus('sidebar'), {
      skipLayout: true,
      width: 360,
      viewportHeight: 260,
      click: '.filter-menu .k-iconbtn',
    }),
  ];
};

const usageVariants = (): Variant[] => {
  const u = fixtureCorpus.bind(null, 'usage', usageRenderFixtures as () => readonly { scenario: string; state: unknown }[]);
  const populated = (): ViewCorpus => getCorpus('usage');
  return [
    variant('usage', 'populated', populated, { baseline: 'usage', themes: ALL_THEMES }),
    // T1302 tiers (@ui:RD-TIERS): a tier variant differs only in width, so it shares the populated layout run.
    variant('usage', 'populated-narrow', populated, { width: 500 }),
    variant('usage', 'populated-tight', populated, { width: 360 }),
    variant('usage', 'empty', u('empty')),
    variant('usage', 'loading', LOADING),
    variant('usage', 'error', u('error')),
    variant('usage', 'long-content', u('hostile')),
    variant('usage', 'paged', u('paged-middle')),
    variant('usage', 'sorted', u('all-sorts')),
    // T1302 US-35: the real long key at wide (1280) and mid (800); the two share one layout run.
    variant('usage', 'long-key', u('long-key'), { width: 1280 }),
    variant('usage', 'long-key-mid', u('long-key'), { width: 800 }),
    // T1302 US-2: a host failure states the error and one way forward instead of a blank page.
    variant('usage', 'host-failure', u('host-failure')),
    // T1302 US-10/US-19: the near state at every theme, plus the grayscale audit; exhausted in both.
    variant('usage', 'quota-near', u('quota-near'), { themes: [...ALL_THEMES, 'dark-grayscale'] }),
    variant('usage', 'quota-exhausted', u('quota-exhausted'), { themes: ['dark', 'dark-grayscale'] }),
    variant('usage', 'quota-expired', u('quota-expired')),
    variant('usage', 'quota-stale', u('quota-stale')),
    variant('usage', 'quota-empty', u('quota-empty')),
    variant('usage', 'quota-tight', u('quota-near'), { width: 360 }),
  ];
};

const resourcesVariants = (): Variant[] => {
  const r = fixtureCorpus.bind(null, 'resources', resourcesRenderFixtures as () => readonly { scenario: string; state: unknown }[]);
  /**
   * The Servers-tab fixtures carry three host messages (`state`, `servers`,
   * `show-tab`); `fixtureCorpus` sends only `state`, which renders the Resources
   * tab. T1317 RS-10: the Servers tab had no baseline at all.
   */
  const s = (scenario: ResourcesScenario): (() => ViewCorpus) => () => {
    const hit = resourcesRenderFixtures().find((f) => f.scenario === scenario);
    if (!hit) throw new Error(`resources: no '${scenario}' render fixture`);
    return { messages: fixtureMessages(hit) };
  };
  return [
    variant('resources', 'populated', () => getCorpus('resources'), { baseline: 'resources', themes: ALL_THEMES }),
    variant('resources', 'empty', r('idle')),
    variant('resources', 'loading', LOADING),
    variant('resources', 'error', r('degraded')),
    variant('resources', 'long-content', r('hostile')),
    variant('resources', 'unsupported', r('unsupported')),
    variant('resources', 'waste', r('waste')),
    variant('resources', 'unattributed', r('unattributed')),
    // T1317 RS-10: the Servers tab, which had no baseline at all. Mixed is the full page in every
    // theme, plus grayscale for the status marks (@ui:UI-R28); a failed start shows its reason in
    // all three themes (RS-2). `dark-grayscale` and `dark-reduced-motion` re-make the two stale
    // resources baselines an older sweep left behind.
    variant('resources', 'servers-mixed', s('servers-mixed'), { themes: [...ALL_THEMES, 'dark-grayscale'] }),
    variant('resources', 'servers-none', s('servers-none')),
    variant('resources', 'servers-done', s('servers-done')),
    variant('resources', 'servers-unavailable', s('servers-unavailable')),
    variant('resources', 'servers-hostile', s('servers-hostile')),
    variant('resources', 'servers-failed', s('servers-failed'), { themes: ALL_THEMES }),
    variant('resources', 'servers-crashed', s('servers-crashed')),
    variant('resources', 'servers-starting', s('servers-starting'), { themes: ['dark', 'dark-reduced-motion'] }),
  ];
};

const diffsVariants = (): Variant[] => {
  const d = fixtureCorpus.bind(null, 'diffs', diffsRenderFixtures as () => readonly { scenario: string; state: unknown }[]);
  const populated = d('populated');
  return [
    variant('diffs', 'populated', () => getCorpus('diffs'), { baseline: 'diffs', themes: ALL_THEMES }),
    // T1298: one worktree with one commit and no pending changes — the singular count texts.
    variant('diffs', 'one-commit', d('one-commit'), { skipLayout: true }),
    variant('diffs', 'empty', d('empty')),
    variant('diffs', 'clean', d('clean')),
    variant('diffs', 'loading', LOADING),
    variant('diffs', 'error', d('error')),
    variant('diffs', 'refresh-failed', () => ({
      messages: [...populated().messages, { type: 'error', message: 'git exited with code 128' }],
    })),
    // DF-11: 1,500 files, 200 rows rendered per group until "Show all files".
    variant('diffs', 'many-files', d('many')),
    variant('diffs', 'long-content', d('hostile')),
    // DF-21: the narrow (400-699) and tight (<=399) tiers, where the header actions wrap and the indents stop.
    variant('diffs', 'diffs-narrow', () => getCorpus('diffs'), { width: 500 }),
    variant('diffs', 'diffs-tight', () => getCorpus('diffs'), { width: 360 }),
  ];
};

const gettingStartedVariants = (): Variant[] => {
  const g = fixtureCorpus.bind(null, 'gettingStarted', gettingStartedRenderFixtures as () => readonly { scenario: string; state: unknown }[]);
  return [
    variant('gettingStarted', 'populated', () => getCorpus('gettingStarted'), { baseline: 'gettingStarted', themes: ALL_THEMES }),
    variant('gettingStarted', 'empty', g('empty')),
    variant('gettingStarted', 'loading', LOADING),
    variant('gettingStarted', 'error', () => ({ messages: [{ type: 'state-error', message: 'spawn git ENOENT' }] })),
    variant('gettingStarted', 'fresh', g('fresh')),
    variant('gettingStarted', 'returning', g('returning')),
    variant('gettingStarted', 'agent-missing', g('agent-missing')),
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
  // T1266: the Dynamic Graph approach is selected, so the settings region lists expert / worker / fast.
  const graphRoles = () =>
    withState({
      ...edit,
      approaches: [{ id: 'karst-graph-engineering', label: 'Dynamic Graph', description: '', recommended: true, installed: true, enabled: true }],
      selectedApproach: 'karst-graph-engineering',
      agentPresetNames: ['fast', 'deep'],
      selectedAgentPreset: 'deep',
      defaultAgentPreset: 'fast',
      // SET-35: `describeGraphRoles` prints the core and model labels, never the raw
      // ids. The fixture bypasses the host, so it carries the labelled shape.
      graphRoles: {
        'karst-graph-engineering': {
          deep: [
            { role: 'expert', text: 'Codex · GPT-5.6 Sol · high', source: 'preset' },
            { role: 'worker', text: 'Claude Code · Sonnet 5.5 · low', source: 'approach' },
            { role: 'fast', text: 'Claude Code · Sonnet 5.5 · low', source: 'approach' },
          ],
        },
      },
    });
  // T1308 (arch:AC-63): a legacy graph ticket whose row still holds a stale core, model and
  // effort. The picker shows the preset only, and the chips stay preset/approach.
  const graphRolesLegacyCore = () =>
    withState({
      ...edit,
      approaches: [{ id: 'karst-graph-engineering', label: 'Dynamic Graph', description: '', recommended: true, installed: true, enabled: true }],
      selectedApproach: 'karst-graph-engineering',
      agentProviders: ['claude', 'codex', 'opencode2'],
      agentPresetNames: ['fast', 'deep'],
      selectedAgentPreset: null,
      defaultAgentPreset: 'fast',
      selectedAgentProvider: 'opencode2',
      selectedModel: 'kimi-k2',
      selectedEffort: 'max',
      graphRoles: {
        'karst-graph-engineering': {
          '': [
            { role: 'expert', text: 'Antigravity · Gemini 4 Neon · high', source: 'preset' },
            { role: 'worker', text: 'Claude Code · Sonnet 5.5 · low', source: 'approach' },
            { role: 'fast', text: 'Claude Code · Sonnet 5.5 · low', source: 'approach' },
          ],
        },
      },
    });
  return [
    // SET-63: the role preview's shared labels at every theme, not dark only.
    variant('ticketForm', 'graph-roles', graphRoles, { themes: ALL_THEMES }),
    variant('ticketForm', 'graph-roles-legacy-core', graphRolesLegacyCore),
    variant('ticketForm', 'graph-roles-legacy-core-tight-320', graphRolesLegacyCore, { width: 320 }),
    variant('ticketForm', 'populated', () => getCorpus('ticketForm'), { baseline: 'ticketForm', themes: ALL_THEMES }),
    variant('ticketForm', 'empty', () => withState({})),
    variant('ticketForm', 'loading', LOADING),
    // SET-52: a fetch failure has its own message and renders under the Key row,
    // not in the page-level bucket above the title.
    variant(
      'ticketForm',
      'error',
      () => ({
        messages: [
          ...withState({}).messages,
          { type: 'fetch-error', message: 'Could not fetch FEAT-9999: the provider returned 404 (check the list id).' },
        ],
      }),
      // SET-63: the fetch error is a contrast surface, so light and HC record it too.
      { themes: ALL_THEMES },
    ),
    // D159: an op that died on quota carries its park id, so the error notification
    // offers Pick agent/model, Retry same and Dismiss.
    variant('ticketForm', 'usage-limit-error', () => ({
      messages: [
        ...withState({}).messages,
        {
          type: 'error',
          // SET-52: the real shape of a quota failure — the product name, never a
          // raw provider id ("anthropic: …").
          message: 'Claude Code usage limit reached — monthly quota exceeded. Pick another agent/model, retry, or dismiss.',
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
    // SET-63: the realistic create page at every theme — the light input edge and the
    // HC switch/primary edge are only visible where they were missing (SET-56/57).
    variant('ticketForm', 'realistic-create', () => withState(REALISTIC_TICKET_FORM), { themes: ALL_THEMES }),
    // SET-56 proof (T1301): the Auto-improve switch goes Off while Pull base stays On,
    // so one HC shot holds both switch states and the 3:1 track edge. The toggle changes
    // no geometry, so it shares realistic-create's covered layout instead of a new page
    // (a variant with no dark fixture page cannot join the dark-only layout project).
    variant('ticketForm', 'realistic-create-switches', () => withState(REALISTIC_TICKET_FORM), {
      themes: ['hc'],
      clicks: ['#autoImprove'],
      skipLayout: true,
    }),
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
    // SET-65: the open approach list, not a second copy of the closed form.
    variant('ticketForm', 'approach-picker', () => withState(REALISTIC_TICKET_FORM), { click: '#approachBtn' }),
    // T1091: the approach, agent and base popovers near the bottom edge of a short window.
    variant('ticketForm', 'approach-picker-bottom-edge', () => withState(REALISTIC_TICKET_FORM), {
      skipLayout: true,
      width: 800,
      viewportHeight: BOTTOM_EDGE_HEIGHT,
      capture: 'viewport',
      click: '#approachBtn',
    }),
    variant('ticketForm', 'agent-picker-bottom-edge', editCoreModel, {
      skipLayout: true,
      width: 800,
      viewportHeight: BOTTOM_EDGE_HEIGHT,
      capture: 'viewport',
      click: '[data-ap-trigger="core"]',
    }),
    // T1301 (RD-AGENT-MENU): the open agent-core menu at the wide 799-tall window must end above the sticky
    // action bar (or open above its trigger), leaving all three footer buttons visible.
    variant('ticketForm', 'agent-picker-open', editCoreModel, {
      viewportHeight: 799,
      capture: 'viewport',
      click: '[data-ap-trigger="core"]',
    }),
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

/** A clock value in a corpus (`stageSince`, `startedAt`): the layout gate measures geometry, not the time text. */
const ISO_TIMESTAMP = /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/g;

/**
 * What decides the page the layout gate measures for a variant (@ui:VISUAL-VARIANTS): the view, the widths, the
 * fixture page (`buildFixture` reads only the corpus messages and view state) and the steps `layout.layout.ts` runs
 * (`clicks` only). Screenshot fields (`width`, `themes`, `capture`, `viewportHeight`, `click`, `pills`, the popover
 * and drawer steps) are not part of it. Add a field here when `layout.layout.ts` starts to run it.
 */
export function layoutIdentity(view: ViewId, variant: Variant): string {
  const corpus = variant.corpus();
  return JSON.stringify([view, layoutWidthsFor(view, variant.id), corpus.messages, corpus.viewState ?? null, variant.clicks ?? []]).replace(
    ISO_TIMESTAMP,
    '<time>',
  );
}

export interface LayoutPlan {
  readonly targets: readonly LayoutTarget[];
  /** `<view>/<variant>` of a variant whose page an earlier target already measures → the id of that target. */
  readonly sharedWith: ReadonlyMap<string, string>;
}

let plan: LayoutPlan | undefined;

/**
 * Layout-gate runs, one per distinct page (ui:UI-R57). A variant that opens the same page as an earlier variant (it
 * differs only in screenshot fields, e.g. a tier variant with its own `width`) shares that run: the gate already opens
 * the page at every width. Settings route variants keep their settingsRoutes() id and are never shared.
 */
export function layoutPlan(): LayoutPlan {
  if (plan !== undefined) return plan;
  const targets: LayoutTarget[] = [];
  const sharedWith = new Map<string, string>();
  const firstById = new Map<string, string>();
  for (const view of WEBVIEW_NAMES) {
    for (const variant of VARIANTS[view].filter((v) => !v.skipLayout)) {
      const id = variant.layoutRouteId ?? `${view}/${variant.id}`;
      if (variant.layoutRouteId === undefined) {
        const key = layoutIdentity(view, variant);
        const first = firstById.get(key);
        if (first !== undefined) {
          sharedWith.set(id, first);
          continue;
        }
        firstById.set(key, id);
      }
      targets.push({ id, view, variant });
    }
  }
  plan = { targets, sharedWith };
  return plan;
}

/** Layout-gate runs, one per distinct page; settings route variants reuse their settingsRoutes() id. */
export function layoutTargets(): readonly LayoutTarget[] {
  return layoutPlan().targets;
}

/** Layout targets that are not settings routes: settings routes keep their settingsRoutes() runs. */
export function extraLayoutTargets(): readonly LayoutTarget[] {
  return layoutTargets().filter((t) => t.variant.layoutRouteId === undefined);
}
