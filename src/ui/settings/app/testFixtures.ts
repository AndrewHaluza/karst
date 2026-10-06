/**
 * Test-only fixtures for the settings app's state boundary: one representative
 * `SettingsHostMessage` per union variant, plus a ready-made `SettingsState`.
 *
 * Two things depend on this module being exhaustive:
 *
 * - `roundTrip.test.ts` walks `HOST_MESSAGE_FIXTURES` and requires every fixture
 *   to survive `structuredClone` and `JSON.parse(JSON.stringify(...))` deep-equal
 *   (NDL-126 §3, UI-R-X2). A new union variant with no fixture fails the exhaustiveness
 *   assertion rather than silently escaping the serializability check.
 * - `reducer.test.ts` reduces over the same list, so a new variant cannot arrive
 *   without the reducer having been taught to handle it (its `assertNever` would
 *   already catch that at `tsc`, but the runtime list makes the coverage explicit).
 *
 * Kept out of `App.tsx`'s import graph on purpose — nothing in `app/` except a
 * test imports it, so none of this reaches the bundled webview asset.
 */
import type { Manifest } from '../../../manifest/types.js';
import { buildSettingsState, type SettingsState } from '../state.js';
import type { SettingsHostMessage } from '../messages.js';
import { manifest as buildManifest, runnableRepo, slot } from '../../../manifest/fixtures.js';

/** A manifest with enough surface for dirty-tracking to be meaningful. */
export const FIXTURE_MANIFEST: Manifest = buildManifest(
  {
    backend: runnableRepo({ ports: [slot('port', 'PORT', 3000)] }, { repoPath: '../backend' }),
  },
  {
    host: '127.0.0.1',
    portRange: [4000, 4999],
    baselineBranch: 'main',
    approaches: [{ id: 'tdd', label: 'TDD', recommended: true }],
    agents: { implement: { role: 'implement', command: 'claude' } },
    worktreePathDisplay: 'relative',
  },
);

/** A second manifest, differing only in `general`'s fields — one dirty tab. */
export const EDITED_MANIFEST: Manifest = {
  ...FIXTURE_MANIFEST,
  host: '0.0.0.0',
};

/** A second manifest, differing only in `ticketing` — a different dirty tab. */
export const TICKETING_EDITED_MANIFEST: Manifest = {
  ...FIXTURE_MANIFEST,
  ticketing: { provider: 'clickup', listId: 'L1', teamId: 'T1' },
};

/** A ready-made host state push (the opening message of every panel session). */
export const FIXTURE_STATE_PUSH: SettingsState = buildSettingsState(
  FIXTURE_MANIFEST,
  null,
  ['tdd'],
  true,
  ['claude', 'codex'],
  [{ name: 'implement', source: 'file', enabled: true, body: 'body' }],
  { tdd: ['karst-tdd'] },
  undefined,
  '/repo/karst.yml',
  { value: 'repo', derived: false },
  '1.2.3',
  [{ id: 'tdd', label: 'TDD', recommended: true }],
  { claude: ['claude-sonnet'] },
);

/** One fixture per `SettingsHostMessage` variant. Keep this list exhaustive. */
export const HOST_MESSAGE_FIXTURES: ReadonlyArray<{
  readonly name: string;
  readonly message: SettingsHostMessage;
}> = [
  { name: 'state', message: { type: 'state', state: FIXTURE_STATE_PUSH } },
  {
    name: 'state-with-error',
    message: {
      type: 'state',
      state: buildSettingsState(FIXTURE_MANIFEST, 'Invalid karst.yml: portRange min exceeds max'),
    },
  },
  {
    name: 'models',
    message: {
      type: 'models',
      models: { claude: [], codex: [], antigravity: [], opencode: [], opencode2: [] },
      modelCompatibility: { claude: [], codex: [], antigravity: [], opencode: [], opencode2: [] },
      recentModels: { claude: ['claude-opus'] },
    },
  },
  { name: 'process-assignment-views', message: { type: 'process-assignment-views', rows: [] } },
  {
    name: 'validation-ok',
    message: { type: 'validation', ok: true, error: null },
  },
  {
    name: 'validation-failed',
    message: {
      type: 'validation',
      ok: false,
      error: 'Invalid karst.yml: repository "backend".repoPath is required',
    },
  },
  { name: 'error', message: { type: 'error', message: 'Could not read karst.yml' } },
  { name: 'saved-with-section', message: { type: 'saved', section: 'general' } },
  { name: 'saved-whole-draft', message: { type: 'saved' } },
  {
    name: 'approach-command-body',
    message: { type: 'approach-command-body', approachId: 'tdd', command: 'start', body: '# start' },
  },
  { name: 'ticket-statuses', message: { type: 'ticket-statuses', statuses: ['open', 'in progress'] } },
  {
    name: 'ticket-statuses-error',
    message: { type: 'ticket-statuses-error', message: 'No token configured' },
  },
  { name: 'ticket-lists', message: { type: 'ticket-lists', lists: [] } },
  { name: 'ticket-lists-error', message: { type: 'ticket-lists-error', message: 'Workspace unreadable' } },
  { name: 'token-state-configured', message: { type: 'token-state', configured: true } },
  { name: 'token-state-cleared', message: { type: 'token-state', configured: false } },
  {
    name: 'repo-path-picked',
    message: { type: 'repo-path-picked', name: 'backend', path: '/abs/backend' },
  },
  {
    name: 'action-result-ok',
    message: { type: 'action-result', requestId: 'm1', ok: true },
  },
  {
    name: 'action-result-failed',
    message: { type: 'action-result', requestId: 'm2', ok: false, message: 'nope' },
  },
];

/**
 * The `SettingsHostMessage` variant names, derived from the fixtures.
 *
 * Compared against the union at runtime so a NEW variant with no fixture fails
 * here too. (The compile-time half lives in the test: `Extract` over the union
 * would resolve to `never`, and the round-trip loop is only meaningful while the
 * fixture list is the whole union.)
 */
export const FIXTURE_VARIANT_NAMES = HOST_MESSAGE_FIXTURES.map((f) => f.message.type);