/**
 * REALISTIC settings state for the layout-sanity gate (`layout.visual.ts`).
 *
 * MINIMAL_SETTINGS (corpora.ts) is an empty manifest on the General tab, so it
 * cannot expose a geometry bug on a populated page. This state is built through
 * the host's own `buildSettingsState`, so its shape cannot drift from what the
 * panel pushes: two repositories, three presets (one active, differing on more
 * than three roles), pinned roles, local + approach profiles (one 45-line body),
 * a 60+ char model id and a 40+ char preset name — the content that breaks
 * layouts.
 */
import { buildSettingsState, type SettingsAgentRow } from '../../src/ui/settings/state.js';
import { manifest, runnableRepo, slot, repo } from '../../src/manifest/fixtures.js';
import type { AgentPreset, Manifest } from '../../src/manifest/types.js';

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

export const REALISTIC_SETTINGS = {
  ...buildSettingsState(
    MANIFEST,
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
  currentSection: 'general',
};
