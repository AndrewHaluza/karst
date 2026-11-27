/** The dashboard variants (ui:VISUAL-VARIANTS). */
import {
  populatedStateFor,
  renderStateFor,
  renderFixtures,
  sharedServerFixtures,
  shipPreviewStateFor,
  type RenderRepoCount,
  type RenderScenario,
} from '../../../src/ui/dashboard/renderFixtures.js';
import { renderBrief } from '../../../src/integrations/briefMarkdown.js';
import type { DashboardState } from '../../../src/ui/dashboard/state.js';
import { ticketRefView } from '../../../src/ui/shared/ticketRefView.js';
import { INSIDE_CASES } from '../../../src/ui/dashboard/insideCases.js';
import { stallFixtureState, type StallFixtureKind } from '../../../src/ui/dashboard/stallFixtures.js';
import { buildStageRail } from '../../../src/model/stageRail.js';
import { PANEL_TIERS, PANEL_VARIANTS } from '../panelVariants.js';
import { BASELINE_VARIANTS, baselineState } from '../baselineVariants.js';
import { showcaseCorpus } from '../dbCorpus/showcase.js';
import {
  ALL_THEMES,
  BOTTOM_EDGE_HEIGHT,
  LOADING,
  LONG_TITLE,
  variant,
  stateMessage,
  type AgentPopoverSteps,
  type RuntimeOpen,
  type TicketDetailsSteps,
  type Variant,
  type ViewCorpus,
} from '../variantCore.js';

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

/**
 * T1359: a blocked dynamic-graph run on `impl`, with the host's recovery verdict (`DashboardState.graphBlock`).
 * The banner renders the one action that will not refuse (Replan) and the rail only mirrors the wait — the
 * same split D744 gave the merge-conflict banner.
 */
function graphScenarioBlocked(
  reason: string,
  graphBlock: NonNullable<DashboardState['graphBlock']>,
): () => ViewCorpus {
  return dashboardScenario('running', 2, (s) => {
    const blocked = { kind: 'approach-graph-failed' as const, reason, at: '2026-01-01T00:00:00.000Z', resumable: true };
    const stepper = s.stepper.map((c) => (c.stageKey === 'impl' ? { ...c, status: 'running' as const, blocked } : c));
    return {
      ...s,
      stageCurrent: 'impl',
      currentStage: { stageKey: 'impl', status: 'running', blocked },
      graphBlock,
      stepper,
      rail: buildStageRail(stepper, stepper, {
        current: 'impl',
        needsUser: true,
        needs: { detail: 'the graph needs a recovery decision', action: 'Open graph', cta: { kind: 'graph-panel' } },
      }),
    };
  });
}

/**
 * T1357 (@ui:VISUAL-VARIANTS): the screenshot step of an Inside case whose state shows only after a click. Without
 * it the page equals a sibling case. Keyed `${stage}-${id}`. `click` is screenshot-only: the layout key stays.
 */
export const INSIDE_CASE_CLICK: Readonly<Record<string, string>> = {
  // The revalidation caption is in the Gates evidence body (EvidenceRows.tsx `gates-caption`); the row is a <details>.
  'uat-gates-revalidation': '[data-proc-id="uat:gates"] > summary',
  // A closed ticket differs from a passed one only in its menu: Reopen in place of Close.
  'done-closed': '#moreBtn',
  // The two review menu cases differ only in the open stage menu: Retry alone here, Retry and Send back in the other.
  'review-menu-retry-only': '[data-stage-menu="review"]',
};

/**
 * T1361 (@ui:VISUAL-VARIANTS): the click steps an Inside case needs before its state is visible. Unlike `click`
 * (screenshot-only) these also run in `layout.layout.ts`, so the geometry gate measures the SAME page the baseline
 * records. Keyed `${stage}-${id}`.
 */
export const INSIDE_CASE_CLICKS: Readonly<Record<string, readonly string[]>> = {
  // The DAG strip renders only after the Graph view toggle (EvidenceGraph.tsx).
  'impl-graph-dag': ['[data-act="toggle-graph-view"]'],
  // A blocked run maps to `wait`, so its graph <details> starts collapsed (InsideLedger.tsx).
  'impl-graph-failed': ['[data-proc-id="impl:graph"] > summary'],
  // T1393: the capped gate list's toggle. Collapsed and nine-gates shots only open the Gates disclosure; the expanded
  // shot then clicks the toggle, so the baseline records all 11 rows and "Show fewer".
  'uat-gates-capped-collapsed': ['[data-proc-id="uat:gates"] > summary'],
  'uat-gates-capped-expanded': ['[data-proc-id="uat:gates"] > summary', '[data-act="toggle-evidence-rows"]'],
  'uat-gates-nine': ['[data-proc-id="uat:gates"] > summary'],
};

/**
 * T1361 (@ui:VISUAL-VARIANTS): the DAG matrix is a horizontally scrolling strip whose 12 columns plus the trailing
 * `uat` chip and `+2 more` cap are ~1,400 px wide. Its default shot therefore records a 1600 px desktop viewport so
 * the whole strip AND the cap are visible; at the 1280 px project default the strip ends past the box and the cap is
 * off-screen. `width` is a screenshot field only: the page keeps its one layout run, and
 * `inside-impl-graph-dag-narrow` (500 px) records the contained scroll.
 */
export const INSIDE_CASE_WIDTHS: Readonly<Record<string, number>> = {
  'impl-graph-dag': 1600,
};

/** ui:VISUAL-VARIANTS: one dark-only variant per Inside stage x state case (aliases reuse an older variant). */
const insideCaseVariants = (): Variant[] =>
  INSIDE_CASES.filter((c) => c.aliasOf === undefined && c.id !== 'live-tokens').map((c) => {
    const click = INSIDE_CASE_CLICK[`${c.stage}-${c.id}`];
    const clicks = INSIDE_CASE_CLICKS[`${c.stage}-${c.id}`];
    const width = INSIDE_CASE_WIDTHS[`${c.stage}-${c.id}`];
    return variant('dashboard', `inside-${c.stage}-${c.id}`, () => stateMessage(c.state()), {
      ...(c.allThemes ? { themes: ALL_THEMES } : {}),
      ...(click === undefined ? {} : { click }),
      ...(clicks === undefined ? {} : { clicks }),
      ...(width === undefined ? {} : { width }),
    });
  });

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

/**
 * T1361 (@ui:VISUAL-VARIANTS-TIERS): the DAG strip's narrow tier. It is defined explicitly rather than through
 * `INSIDE_TIER_CASES` because the tier helper records mid/tight too and drops `clicks`; here the toggle click must run
 * and the variant shares `inside-impl-graph-dag`'s layout run (same corpus, clicks and widths).
 */
const insideGraphDagNarrow = (): Variant[] => {
  const c = INSIDE_CASES.find((x) => x.stage === 'impl' && x.id === 'graph-dag');
  if (!c) throw new Error('variants: no impl graph-dag case');
  return [
    variant('dashboard', 'inside-impl-graph-dag-narrow', () => stateMessage(c.state()), {
      width: 500,
      clicks: INSIDE_CASE_CLICKS['impl-graph-dag']!,
    }),
  ];
};

/** T1099: a viewport height above the 966px content of the ship/wide menu variant. */
const SHIP_MENU_WIDE_VIEWPORT_H = 1000;

/**
 * T1400: the review/tight page is ~1201-1203 px tall, so a 720 px viewport made the full-page capture flip by 2 px
 * and move the open menu's edge by 1 px (311 px of difference between two otherwise identical renders). A viewport
 * above the content pins the capture, the same fix T1099 gave ship/wide.
 */
const REVIEW_MENU_TIGHT_VIEWPORT_H = 1250;

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
        // T1400: the same 2 px capture flip on review/tight.
        ...(stage === 'review' && tier === 'tight' ? { viewportHeight: REVIEW_MENU_TIGHT_VIEWPORT_H } : {}),
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
  // T1357: the core switch already stages the recent Big Pickle, so picking it changed nothing. Kimi K3 Free also has
  // no efforts and is not pre-staged, so the pick moves the selection and hides the effort control.
  agentPopoverVariant('no-effort-model-wide', { core: 'opencode', model: 'opencode/kimi-k3-free' }, 1100),
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
  ['rich', detailsState({ brief: DETAILS_RICH_BRIEF, description: 'Original description from the tracker.', provider: 'jira', ticketUrl: 'https://example.test/browse/FEAT-142', briefSource: { kind: 'provider', provider: 'jira' }, priority: { level: 'high', text: 'high', source: 'provider' } } as Partial<DashboardState>)],
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

/** `[id, patch, open]`: `open` is the popover a state needs open to show what it changes (T1357). */
const RUNTIME_STATES: ReadonlyArray<readonly [string, (s: DashboardState) => DashboardState, RuntimeOpen?]> = [
  ['docker', (s) => ({ ...s, sandbox: SBX_VIEW })],
  ['sbx', (s) => ({ ...s, sandbox: { ...SBX_VIEW, backend: 'sbx', network: 'sbx network policy (allowlist)' } })],
  ['carry', (s) => ({ ...s, sandbox: { ...SBX_VIEW, carry: true } })],
  // The disabled shell and its reason show only in the ⋯ menu; the closed strip equals the docker state.
  ['shell-off', (s) => ({ ...s, sandbox: { ...SBX_VIEW, shell: { available: false, why: 'Sandbox is stopped' } } }), 'more'],
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
  ...RUNTIME_STATES.flatMap(([id, patch, open]) =>
    (RUNTIME_MULTI_WIDTH.has(id) ? RUNTIME_TIERS : RUNTIME_TIERS.slice(0, 1)).map(([tier, width]) =>
      variant('dashboard', `runtime-${id}-${tier}`, dashboardScenario('running', 2, patch), {
        skipLayout: true,
        width,
        ...(open === undefined ? {} : { runtimeOpen: open }),
      }),
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
  ...ticketMenuGatesVariants(),
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

/**
 * T1397 (@ui:UI-R57): the ticket ⋯ menu's gate switches, now one segmented tab row (UAT | Review) with a per-stage
 * count and an ` · N off` marker, above the selected stage's rows only. Three open-menu states: both stages with
 * every gate on (opens on UAT from impl), both stages with a ticket-off and a Settings-off gate (opens on Review),
 * and a single UAT stage (no tab row, the head kept). The popover keeps its 12 control-height width in all three.
 */
const GATE_UAT_NAMES = ['unit', 'docs', 'docs-gate', 'docs-graph', 'integration', 'visual'] as const;
const GATE_REVIEW_NAMES = ['typecheck', 'layer-rules', 'lint-react', 'build', 'deps-audit', 'secrets', 'sast', 'mutation'] as const;

/** One stage's resolved options; `configOff` names are off project-wide (and therefore off for the ticket too). */
const gateOptionList = (names: readonly string[], spec: { readonly off?: readonly string[]; readonly configOff?: readonly string[] } = {}) =>
  names.map((name) => {
    const config = (spec.configOff ?? []).includes(name);
    return { name, disabled: config || (spec.off ?? []).includes(name), ...(config ? { configDisabled: true } : {}) };
  });

const ticketMenuGatesVariants = (): Variant[] => {
  const openMenu = { skipLayout: true, click: '[aria-label="Ticket controls"]' } as const;
  const corpus = (scenario: RenderScenario, options: unknown) => () => {
    const base = dashboardScenario(scenario, 2)();
    return { ...base, messages: [...base.messages, { type: 'gate-options', options }] };
  };
  return [
    variant('dashboard', 'ticket-menu-gates-both', corpus('running', { uat: gateOptionList(GATE_UAT_NAMES), review: gateOptionList(GATE_REVIEW_NAMES) }), openMenu),
    // `failed` renders the review stage: the menu opens on the Review tab, as a review ticket does.
    variant('dashboard', 'ticket-menu-gates-off', corpus('failed', {
      uat: gateOptionList(GATE_UAT_NAMES, { off: ['visual'] }),
      review: gateOptionList(GATE_REVIEW_NAMES, { off: ['secrets'], configOff: ['mutation'] }),
    }), openMenu),
    variant('dashboard', 'ticket-menu-gates-single', corpus('running', { uat: gateOptionList(['unit', 'integration', 'visual']), review: [] }), openMenu),
  ];
};

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
    // The baseline is the open menu with no k-tooltip: the pointer leaves the trigger and the trigger loses focus.
    { skipLayout: true, width: 800, viewportHeight: BOTTOM_EDGE_HEIGHT, click: '[data-stage-menu="review"]', hover: '#title', blur: true },
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

/**
 * T1396 (@ui:UI-R57): the ticket header at the four container tiers (@ui:RD-TIERS). Four states: a graph ticket with a
 * planner's HIGH and a long key, a provider label that names no level (`P2`, the neutral chip), a closed ticket (the
 * status chip says Closed and there is no Done chip), and the scrolled sticky row with the tier's own width. T1400 adds
 * `header-planning-card`: the `P28` link's hover card open at wide, mid and narrow, and the ⋯ twin at tight.
 *
 * Screenshot-only (`skipLayout`), like the other header-changing dashboard states (`graph-header`, `layout-*`,
 * `ticket-menu-*`): the page is the running dashboard, whose header CSS every existing dashboard layout route already
 * exercises at 1280/900/700/699/480 (and every `inside-*` route at 400/399/320). A layout run of these exact pages
 * measures nothing about the header and two PRE-EXISTING clips outside this ticket's scope, which the ledger cannot
 * take as new entries: the graph identity's row-2 `.capModel` (HeaderMeta, out of scope by design) is ellipsised with no
 * accessible name, and at 480 the impl ledger's `.switch-value` timeline cell ellipsises without one.
 */
const HEADER_TIERS = [['wide', 1100], ['mid', 800], ['narrow', 500], ['tight', 360]] as const;

const headerCorpus = (patch: (s: DashboardState) => DashboardState) => dashboardScenario('running', 2, patch);

const headerVariants = (): Variant[] => {
  const graphHigh = (s: DashboardState): DashboardState => ({
    ...s,
    key: 'FEAT-DASHBOARD-THE-TICKET-HEADER-LONG',
    provider: 'clickup',
    ticketUrl: 'https://example.test/t/1396',
    priority: { level: 'high', text: 'high', source: 'planner', reason: 'blocks release' },
    capabilityIdentity: {
      ...s.capabilityIdentity,
      graphExpert: { provider: 'claude', model: 'claude-opus-5', effort: 'high' },
      graphWorker: { provider: 'claude', model: 'claude-sonnet-5', effort: 'low' },
      graphFast: { provider: 'claude', model: 'claude-sonnet-5', effort: 'low' },
    },
  });
  const providerLabel = (s: DashboardState): DashboardState => ({
    ...s,
    key: 'PLATFORM-PROVIDER-PRIORITY-LABEL-99',
    provider: 'jira',
    ticketUrl: 'https://example.test/browse/P2-99',
    priority: { level: null, text: 'P2', source: null },
  });
  const closed = (s: DashboardState): DashboardState => ({
    ...s,
    stageCurrent: 'closed',
    canClose: false,
    canReopen: true,
    priority: { level: 'urgent', text: 'urgent', source: 'you' },
  });
  const stuck = (s: DashboardState): DashboardState => ({
    ...s,
    priority: { level: 'high', text: 'high', source: 'provider' },
  });
  /** T1400: a ticket filed from `D849` in `P28`, with a realistic session and the catalog label its model renders. */
  const planning = (s: DashboardState): DashboardState => ({
    ...s,
    origin: {
      draftRef: 'D849',
      session: {
        id: 28,
        ref: 'P28',
        title: 'Ticket header revamp',
        status: 'filed',
        core: 'claude',
        model: 'claude-opus-5-5',
        drafts: { accepted: 4, pending: 0, discarded: 1 },
        createdAt: '2026-08-10T14:02:00.000Z',
      },
    },
    agentSwitch: {
      ...s.agentSwitch,
      modelsByCore: {
        ...s.agentSwitch.modelsByCore,
        claude: [{ id: 'claude-opus-5-5', label: 'Opus 5.5', providers: ['claude'], tags: ['multimodal', 'vision'], efforts: ['low', 'high'] }],
      },
    },
  });
  const tier = (id: string, corpus: () => ViewCorpus, name: string, width: number): Variant =>
    variant('dashboard', `header-${id}-${name}`, corpus, { width, skipLayout: true });
  return [
    ...HEADER_TIERS.map(([name, width]) => tier('graph-high', headerCorpus(graphHigh), name, width)),
    ...HEADER_TIERS.map(([name, width]) => tier('provider-label', headerCorpus(providerLabel), name, width)),
    ...HEADER_TIERS.map(([name, width]) => tier('closed', headerCorpus(closed), name, width)),
    // T1400: the `P28` link's hover card. Focus opens it at once (0 ms), so the shot records the open card at wide,
    // mid and narrow; at tight the link is hidden and ⋯ carries "Open planning session P28" (no card).
    ...HEADER_TIERS.filter(([name]) => name !== 'tight').map(([name, width]) =>
      variant('dashboard', `header-planning-card-${name}`, headerCorpus(planning), { width, skipLayout: true, focus: '#planLink' }),
    ),
    variant('dashboard', 'header-planning-card-tight', headerCorpus(planning), { width: 360, skipLayout: true, click: '#moreBtn' }),
    ...HEADER_TIERS.map(([name, width]) =>
      variant('dashboard', `header-stuck-${name}`, headerCorpus(stuck), {
        width,
        skipLayout: true,
        // T1396: every page is taller than the 720 px viewport at all four widths, so 240 px puts row 1 under the top
        // edge (data-stuck) and row 2 out of the shot. The sticky shadow is deterministic.
        scrollY: 240,
        capture: 'viewport',
      }),
    ),
  ];
};

export const dashboardVariants = (): Variant[] => [
  ...CHIP_TIERS.map(([tier, width]) =>
    variant('dashboard', `stage-chip-${tier}`, dashboardScenario('running', 2, chipBlockers), { width, themes: CHIP_THEMES }),
  ),
  // T1365: the showcase page is the state the production builders emit from a
  // (seeded) Karst database, sanitized by the exporter — not a hand-written
  // literal that can drift from it. The baseline name stays for the ledger.
  variant('dashboard', 'populated', () => showcaseCorpus('dashboard'), { baseline: 'dashboard-running', themes: ALL_THEMES }),
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
  // T1359, D793: a blocked GRAPH run on impl. Three states, dark-only, each with the layout gate ON (no
  // `skipLayout`), so the gate opens the banner with its Replan row and the longer "replans used n of m"
  // line at every dashboard width (1280/900/700/699/480).
  //  - config: a reparable `config-then-resume` block inside the budget, so no config change is needed;
  //  - explicit: `explicit-resolution`, where Resume refuses by design and no revision budget is readable (`maxReplans: null`);
  //  - exhausted: `resource-claim-violated` evidence kept (D790) with the revision's replan budget spent.
  ...([
    ['graph-blocked-config', 'approach-graph-failed: graph-workspace-deps: node run 3 (web: node_modules missing) (graph run 1)', { primary: 'replan', replanCount: 0, maxReplans: 2 }],
    ['graph-blocked-explicit', 'approach-graph-failed: integration-conflict: git apply refused in src/api.ts (graph run 1)', { primary: 'replan', replanCount: 0, maxReplans: null }],
    ['graph-blocked-replans-exhausted', 'approach-graph-failed: resource-claim-violated: src/outside.ts (graph run 1)', { primary: 'replan', replanCount: 2, maxReplans: 2 }],
  ] as const).map(([id, reason, graphBlock]) =>
    variant('dashboard', id, graphScenarioBlocked(reason, graphBlock)),
  ),
  // T820's subtask-blocked shot left in T1357: it recorded the same picture as `populated` (dashboard-running),
  // whose Sub-tasks panel already shows the blocked blocker, the PR, the agent and the queued row.
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
  ...insideGraphDagNarrow(),
  ...headerVariants(),
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
