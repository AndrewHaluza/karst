/** The settings variants (ui:VISUAL-VARIANTS). */
import { formatAgentsHash } from '../../../src/ui/settings/app/sections/agentsRoute.js';
import { settingsRoutes } from '../settingsRoutes.js';
import {
  CLICKUP_SETTINGS,
  DISCARD_SETTINGS,
  EMPTY_SETTINGS,
  GRAPH_SETTINGS,
  LONG_BODY_PROFILE,
  LONG_PATH_SETTINGS,
  MANUAL_SETTINGS,
  REALISTIC_SETTINGS,
  ROSTER_SETTINGS,
} from '../realisticSettings.js';
import { getCorpus } from '../corpora.js';
import {
  ALL_THEMES,
  BOTTOM_EDGE_HEIGHT,
  DARK_ONLY,
  LOADING,
  variant,
  stateMessage,
  type Variant,
} from '../variantCore.js';

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
    // T1373: the Review section now sits below the UAT rows, below the fixed viewport; scroll to the stall row so the
    // shot still shows the state this variant exists for (the shell scrolls inside a fixed page).
    route: { section: 'quality', scrollTo: '[name="reviewStallEnabled"]' },
  };
}

/** Quality route with UAT gates in one OOM-kill state: default, host-selected, or gate disabled (T853). */
function qualityKillVariant(id: string, gate: Record<string, unknown>, width?: number): Variant {
  const manifest = { ...REALISTIC_SETTINGS.manifest, uat: { ...REALISTIC_SETTINGS.manifest.uat, gates: [{ name: 'unit', kind: 'command', command: 'npm', args: ['test'], ...gate }] } };
  return {
    ...variant('settings', id, () => stateMessage({ ...REALISTIC_SETTINGS, manifest } as never), {
      baseline: `settings--${id}`,
      themes: DARK_ONLY,
      skipLayout: true,
      ...(width === undefined ? {} : { width }),
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

/** T1405: the Channels map below 700 px, where each session kind stacks (@ui:UI-R43, @ui:UI-R57). */
const CHANNELS_NARROW = [
  ['channels-narrow', 630, { tab: 'channels' }],
  ['channels-tight', 320, { tab: 'channels', selected: 'antigravity' }],
] as const;

const channelsNarrowVariants = (): Variant[] =>
  CHANNELS_NARROW.map(([id, width, route]) => ({
    ...variant('settings', id, () => stateMessage(REALISTIC_SETTINGS), {
      baseline: `settings--${id}`,
      themes: DARK_ONLY,
      // The channels route layout runs already cover the page at every width.
      skipLayout: true,
      width,
    }),
    route: { section: 'agents', hash: formatAgentsHash(route) },
  }));

/**
 * T1297 SET-26: the graph approach card at the wide, mid and narrow tiers (@ui:UI-R57).
 * T1374: the agents, limits and planner prompt moved off the card into the Edit
 * drawer, so each shot opens that drawer instead of the roster card.
 */
const APPROACHES_GRAPH = [
  ['approaches-graph', 1100],
  ['approaches-graph-mid', 800],
  ['approaches-graph-narrow', 630],
] as const;

/** The Edit button of one roster card (`text-is`, so the switch and Install are never matched). */
const editCard = (id: string): string => `[data-approach="${id}"] button:text-is("Edit")`;

const openGraphDrawer = [editCard('karst-graph-engineering')];

const approachesGraphVariants = (): Variant[] =>
  APPROACHES_GRAPH.map(([id, width]) => ({
    ...variant('settings', id, () => stateMessage(GRAPH_SETTINGS), {
      baseline: `settings--${id}`,
      themes: DARK_ONLY,
      // The approaches route layout run already covers the page at every width.
      skipLayout: true,
      width,
      // A fixed overlay: the shot is the viewport, not the page height below it.
      capture: 'viewport',
      clicks: openGraphDrawer,
    }),
    route: { section: 'approaches' },
  }));

/**
 * T1374: the roster at the wide and narrow tiers (Installed, Available, Built-in,
 * with the graph card's one-line summary and no pickers or limit inputs), and the
 * drawer of a git-sourced approach at the wide tier (@ui:UI-R57).
 */
const APPROACHES_ROSTER = [
  ['approaches-roster', 1100],
  ['approaches-roster-narrow', 630],
] as const;

const approachesRosterVariants = (): Variant[] =>
  APPROACHES_ROSTER.map(([id, width]) => ({
    ...variant('settings', id, () => stateMessage(ROSTER_SETTINGS), {
      baseline: `settings--${id}`,
      themes: DARK_ONLY,
      // The approaches route layout run already covers the page at every width.
      skipLayout: true,
      width,
    }),
    route: { section: 'approaches' },
  }));

const approachesDrawerGitVariants = (): Variant[] => [
  {
    ...variant('settings', 'approaches-drawer-git', () => stateMessage(ROSTER_SETTINGS), {
      baseline: 'settings--approaches-drawer-git',
      themes: DARK_ONLY,
      // The approaches route layout run already covers the page at every width.
      skipLayout: true,
      width: 1100,
      // A fixed overlay: the shot is the viewport, not the page height below it.
      capture: 'viewport',
      clicks: [editCard('team-review')],
    }),
    route: { section: 'approaches' },
  },
];

const AUTOPILOT_FAULT = 'Invalid karst.yml: autopilot.conflicts.maxRounds must be a whole number of at least 1';
const AUTOPILOT_TIERS = [['mid', 800], ['narrow', 480]] as const;
// T1372 acceptance 3: five long check names push the chip flow to the point where
// the inline add input and its button must stay together.
const MANY_CHECKS = [
  'lint-every-workspace-and-package',
  'typecheck-all-projects',
  'test:integration-the-long-way',
  'docs-graph-and-docs-gate',
  'mutation-score-the-whole-repo',
];

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

export const settingsVariants = (): Variant[] => [
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
  // T1368 (D829): the same compact quota list under the 699 px container tier — label, help, then the control
  // under them, left-aligned (UI-R43), with no horizontal scroll. One core so the card is inside the viewport.
  accountsVariant('accounts-quota-narrow', DEFAULT_ONLY_CORES.slice(0, 1), {
    skipLayout: true,
    themes: DARK_ONLY,
    width: 400,
    settings: { ...REALISTIC_SETTINGS, manifest: { ...REALISTIC_SETTINGS.manifest, quota: { warnThresholdPct: 90, claudeGlobalStatusline: true, claudeOauthUsageApi: true } } } as typeof REALISTIC_SETTINGS,
  }),
  qualityStallVariant('quality-stall-disabled', { enabled: false, sameFileRounds: 3, repeatedFindingRounds: null }),
  qualityKillVariant('quality-oom-default', {}),
  qualityKillVariant('quality-oom-host', { onResourceKill: 'host' }),
  qualityKillVariant('quality-oom-disabled', { enabled: false }),
  // T1373 (@ui:UI-R55): the same gate at the 400 px tier, where the container is under 700 px and a gate is a card.
  // skipLayout through `qualityKillVariant`: `route-quality` already opens the page at every settings width.
  qualityKillVariant('quality-oom-narrow', {}, 400),
  ...autopilotVariants(),
  ...navNarrowVariants(),
  ...rolesNarrowVariants(),
  ...rolesGraphVariants(),
  ...channelsNarrowVariants(),
  ...approachesGraphVariants(),
  ...approachesRosterVariants(),
  ...approachesDrawerGitVariants(),
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
  // T1297 SET-29 + T1371: a saved ClickUp board with its list and statuses in
  // the host's replies; one toggle makes the topbar dirty.
  {
    ...variant('settings', 'ticketing-clickup', () => stateMessage(CLICKUP_SETTINGS), {
      themes: DARK_ONLY,
      skipLayout: true,
      click: 'input[name="searchEnabled"]',
      replies: [
        { type: 'ticket-lists', lists: [{ id: '901', name: 'Sprint 41', space: 'Engineering' }] },
        { type: 'ticket-statuses', statuses: ['backlog', 'in progress', 'in review', 'qa', 'done'] },
      ],
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
