/**
 * REALISTIC settings state for the layout-sanity gate (`layout.layout.ts`).
 *
 * MINIMAL_SETTINGS (corpora.ts) is an empty manifest on the General tab, so it
 * cannot expose a geometry bug on a populated page. This state is built through
 * the host's own `buildSettingsState`, so its shape cannot drift from what the
 * panel pushes: two repositories, three presets (one active, differing on more
 * than three roles), pinned roles, local + approach profiles (one 45-line body),
 * a 60+ char model id and a 40+ char preset name — the content that breaks
 * layouts.
 */
import { buildSettingsState, type SettingsAgentRow, type SettingsState } from '../../src/ui/settings/state.js';
import { manifest, runnableRepo, slot, repo } from '../../src/manifest/fixtures.js';
import { DEFAULT_GRAPH_LIMITS } from '../../src/manifest/graphConfig.js';
import type { AgentPreset, ApproachDef, Manifest } from '../../src/manifest/types.js';

export const LONG_MODEL_ID =
  'opencode-go/very-long-vendor-model-identifier-with-many-segments-2026-05-01-preview';
export const LONG_PRESET_NAME = 'release-candidate-hardening-and-long-run-budget';
export const ACTIVE_PRESET = 'balanced';
export const COMPARE_PRESET = 'fast';
export const LONG_BODY_PROFILE = 'long-body-profile';
export const SHORT_PROFILE = 'security-reviewer';
export const APPROACH_PROFILE = 'tdd-implementer';
/** First role of the Roles table (PROCESS_KEYS order). */
export const FIRST_ROLE = 'uatTester';

const longBody = Array.from(
  { length: 45 },
  (_, i) => `${i + 1}. Step ${i + 1}: read the diff, name the risk precisely, and cite the file and line it comes from.`,
).join('\n');

const PRESETS: Record<string, AgentPreset> = {
  [ACTIVE_PRESET]: {
    label: 'Balanced',
    slots: {
      uatTester: { provider: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' },
      uatFix: { provider: 'claude', model: 'claude-opus-5-5', effort: 'high' },
      review: { provider: 'codex', model: 'gpt-5.1-codex', effort: 'high' },
      reviewFix: { provider: 'claude', model: 'claude-sonnet-5-5' },
      implementation: { provider: 'claude', model: 'claude-opus-5-5', effort: 'high' },
      planning: { provider: 'claude', model: 'claude-fable-5-1' },
    },
  },
  [COMPARE_PRESET]: {
    label: 'Fast',
    slots: {
      uatTester: { provider: 'claude', model: 'claude-haiku-5-5' },
      uatFix: { provider: 'claude', model: 'claude-sonnet-5-5' },
      review: { provider: 'claude', model: 'claude-sonnet-5-5' },
      reviewFix: { provider: 'claude', model: 'claude-haiku-5-5' },
      implementation: { provider: 'opencode', model: 'opencode-go/deepseek-v4-flash' },
    },
  },
  [LONG_PRESET_NAME]: {
    label: 'Release candidate hardening and long-run budget',
    slots: {
      uatTester: { provider: 'opencode', model: LONG_MODEL_ID, effort: 'high' },
      review: { provider: 'opencode', model: LONG_MODEL_ID },
      implementation: { provider: 'codex', model: 'gpt-5.1-codex', effort: 'high' },
      prDescription: { provider: 'claude', model: 'claude-haiku-5-5' },
    },
  },
};

const MANIFEST: Manifest = manifest(
  {
    backend: runnableRepo(
      { ports: [slot('http', 'PORT', 3000), slot('debug', 'DEBUG_PORT', 9229)] },
      { repoPath: '../backend', hasMigrations: true },
    ),
    'web-frontend-with-a-rather-long-repository-name': repo({ repoPath: '../web-frontend' }),
  },
  {
    baselineBranch: 'develop',
    approaches: [{ id: 'tdd', label: 'TDD', recommended: true }],
    agents: {
      [LONG_BODY_PROFILE]: { role: 'review', command: 'claude' },
      [SHORT_PROFILE]: { role: 'review', command: 'claude' },
    },
    agentProvider: 'claude',
    defaultModel: 'claude-sonnet-5-5',
    agentPresets: PRESETS,
    activeAgentPreset: ACTIVE_PRESET,
    // T1371: a connected ClickUp board, so the layout gate opens the REAL
    // Ticketing list — two sections, eight rows — instead of the manual stub.
    // The statuses are saved, so nothing depends on a host reply to render.
    ticketing: {
      provider: 'clickup',
      teamId: '90121889250',
      listId: '901',
      syncSubtasks: 'link',
      advanceOnStart: true,
      startStatus: 'in progress',
      advanceOnShip: true,
      shipStatus: 'qa',
    },
    processes: {
      uatTester: { pinned: true, provider: 'claude', model: 'claude-opus-5-5', effort: 'high' },
      review: { pinned: true, provider: 'opencode', model: LONG_MODEL_ID, effort: 'medium' },
      reviewFix: { agent: SHORT_PROFILE },
    },
  },
);

const AGENT_ROWS: SettingsAgentRow[] = [
  { name: LONG_BODY_PROFILE, source: 'file', enabled: true, body: longBody },
  { name: SHORT_PROFILE, source: 'file', enabled: true, body: 'Review for injection and secret leaks.' },
  { name: APPROACH_PROFILE, source: 'approach', approachId: 'tdd', enabled: true, body: '# TDD implementer\nWrite the failing test first.' },
];

/** The host state these fixtures share: a SettingsState pinned to the General tab. */
export type RealisticSettings = SettingsState & { readonly currentSection: 'general' };

/** The host state shape for one manifest, with the realistic presets and agent rows. */
function realisticState(m: Manifest): RealisticSettings {
  return {
    ...buildSettingsState(
      m,
      null,
      ['tdd'],
      true,
      ['claude', 'codex', 'antigravity', 'opencode'],
      AGENT_ROWS,
      { tdd: ['karst-tdd'] },
      undefined,
      '/work/project/karst.yml',
      { value: 'realistic-project', derived: false },
      '1.2.3',
      [{ id: 'tdd', label: 'TDD', recommended: true }],
      { claude: ['claude-sonnet-5-5'] },
    ),
    currentSection: 'general' as const,
  };
}

export const REALISTIC_SETTINGS = realisticState(MANIFEST);

/**
 * T1297: the same realistic page over one patched manifest (a ticketing
 * provider state, a long repository path, General's own display flags). The
 * host builds the state from the manifest, so a variant cannot drift from the
 * shape the panel pushes.
 */
export function settingsWithManifest(over: Partial<Manifest>): RealisticSettings {
  return realisticState({ ...MANIFEST, ...over });
}

/** A 120-character repository path: the middle-ellipsis case (@ui:UI-R44, SET-25). */
export const LONG_REPO_PATH = `${'../deep/directory/'.repeat(6)}web-frontend`;

/** T1297 SET-25: the Repositories page with a path too long for its cell. */
export const LONG_PATH_SETTINGS = settingsWithManifest({
  repositories: {
    ...MANIFEST.repositories,
    backend: { ...MANIFEST.repositories['backend']!, repoPath: LONG_REPO_PATH },
  },
});

/** T1297 Q11: General's display flags on, so a discarded edit still reads as checked. */
export const DISCARD_SETTINGS = settingsWithManifest({
  debug: true,
  closeDoneTerminalsWithTicket: true,
  diffsInSourceControl: true,
});

/** T1297 SET-28: a manual board, which has no connection fields. */
export const MANUAL_SETTINGS = settingsWithManifest({ ticketing: { provider: 'manual' } });

/**
 * T1297 SET-29 + T1371: a saved ClickUp board with its list and its statuses in
 * the host's replies, and search starting off so the variant's one click makes
 * the topbar dirty without hiding a field the shot must show.
 */
export const CLICKUP_SETTINGS = settingsWithManifest({
  ticketing: {
    provider: 'clickup',
    teamId: '9001',
    listId: '901',
    searchEnabled: false,
    syncSubtasks: 'link',
    advanceOnStart: true,
    startStatus: 'in progress',
    advanceOnShip: true,
    shipStatus: 'qa',
  },
});

/** T1297 SET-26: the graph approach card, with the planner and the three execution profiles. */
const GRAPH_APPROACH: ApproachDef = {
  id: 'karst-graph-engineering',
  label: 'Dynamic Graph',
  description: 'Plans the ticket as a graph of bounded nodes, then runs them in dependency order.',
  recommended: false,
  enabled: true,
  graph: {
    planner: { profile: 'expert', prompt: { artifact: 'prompts/karst-planner.md' } },
    profiles: {
      expert: { provider: 'claude', model: 'claude-opus-5-5', effort: 'high' },
      worker: { provider: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' },
      fast: { provider: 'opencode', model: 'opencode-go/deepseek-v4-flash' },
    },
    commands: {},
    limits: { ...DEFAULT_GRAPH_LIMITS },
  },
};

export const GRAPH_SETTINGS = settingsWithManifest({ approaches: [GRAPH_APPROACH] });

/** UX-10: the same host shape with 0 presets and 0 local/approach profiles. */
export const EMPTY_SETTINGS = {
  ...buildSettingsState(
    manifest({ backend: runnableRepo({}, { repoPath: '../backend' }) }, { baselineBranch: 'develop' }),
    null,
    [],
    true,
    ['claude', 'codex', 'antigravity', 'opencode'],
    [],
    {},
    undefined,
    '/work/project/karst.yml',
    { value: 'empty-project', derived: false },
    '1.2.3',
    [],
    {},
  ),
  currentSection: 'general',
};
