import { describe, it, expect } from 'vitest';
import { buildSettingsActions, type SettingsActionsDeps } from './actions.js';
import type { SettingsHostMessage } from './messages.js';
import type { Manifest, ApproachDef } from '../../manifest/types.js';
import { manifest as buildManifest, runnableRepo, slot } from '../../manifest/fixtures.js';
import type { TicketingProvider } from '../../integrations/ticketing.js';
import type { TicketingConfig } from '../../manifest/types.js';
import type { ModelCatalog } from '../../agent/modelCatalog.js';

const APPROACH_A: ApproachDef = { id: 'a', label: 'Approach A' };
/** A sourced (git) approach: enabling it requires an installed package. */
const APPROACH_SOURCED: ApproachDef = {
  id: 'rpi',
  label: 'RPI',
  source: { type: 'git', repo: 'owner/rpi', ref: 'main', include: ['prompts/'] },
};

/** An npm-source approach: installing it shells out `source.command`. */
const APPROACH_NPM: ApproachDef = {
  id: 'gsd',
  label: 'Get Shit Done',
  source: {
    type: 'npm',
    package: 'get-shit-done',
    command: 'npx get-shit-done init',
    collect: ['.claude/commands'],
  },
};

const VALID: Manifest = buildManifest(
  {
    api: runnableRepo(
      { ports: [slot('port', 'PORT', 3000)] },
      { repoPath: '../api', signals: [] },
    ),
  },
  {
    portRange: [4000, 4999],
    approaches: [APPROACH_A],
    agents: {},
    worktreePathDisplay: 'relative',
  },
);

const NPM_MANIFEST: Manifest = { ...VALID, approaches: [APPROACH_NPM] };

const REMOTE_MODELS: ModelCatalog = {
  claude: [{ id: 'claude-remote', label: 'Claude Remote', providers: ['claude'] }],
  codex: [{ id: 'codex-remote', label: 'Codex Remote', providers: ['codex'] }],
  antigravity: [{ id: 'agy-remote', label: 'Antigravity Remote', providers: ['antigravity'] }],
};

type ModelCatalogDependencyIsRequired =
  {} extends Pick<SettingsActionsDeps, 'modelCatalog'> ? false : true;
const MODEL_CATALOG_DEPENDENCY_IS_REQUIRED: ModelCatalogDependencyIsRequired = true;

function harness(overrides: Partial<SettingsActionsDeps> = {}) {
  const posted: SettingsHostMessage[] = [];
  const order: string[] = [];
  let current = VALID;
  const deps: SettingsActionsDeps = {
    writeManifest: (_p, m) => { order.push('write'); current = m; },
    reloadManifest: () => order.push('reload'),
    onChange: () => order.push('change'),
    loadState: () => ({ manifest: current, error: null }),
    installApproach: async () => { order.push('install'); return undefined; },
    confirmInstallCommand: async () => true,
    uninstallApproach: () => { order.push('uninstall'); return true; },
    listInstalledIds: () => ['a'],
    setToken: async () => { order.push('setToken'); return true; },
    clearToken: async () => { order.push('clearToken'); },
    hasToken: async () => false,
    saveAgentFile: () => order.push('saveAgentFile'),
    deleteAgent: () => order.push('deleteAgent'),
    createAgent: () => order.push('createAgent'),
    listAgentRows: () => [],
    listApproachCommands: () => ({}),
    readApproachCommandBody: () => '',
    makeProvider: () => ({ async updateStatus() {}, async listStatuses() { return []; } }),
    modelCatalog: () => REMOTE_MODELS,
    browseForFolder: async () => undefined,
    openManifest: () => { order.push('openManifest'); },
    ...overrides,
  };
  const factory = buildSettingsActions(deps);
  const actions = factory({
    post: (m) => posted.push(m),
    manifestPath: '/tmp/karst.yml',
    projectSlug: { value: 'proj', derived: false },
  });
  return { actions, posted, order };
}

describe('settings actions — browseRepoPath', () => {
  it('posts repo-path-picked when a folder is chosen', async () => {
    const { actions, posted } = harness({
      browseForFolder: async () => '/Users/nd/code/backend',
    });
    await actions.browseRepoPath('backend');
    expect(posted).toContainEqual({
      type: 'repo-path-picked',
      name: 'backend',
      path: '/Users/nd/code/backend',
    });
  });

  it('posts nothing when the dialog is cancelled', async () => {
    const { actions, posted } = harness({
      browseForFolder: async () => undefined,
    });
    await actions.browseRepoPath('backend');
    expect(posted).toEqual([]);
  });
});

describe('settings actions — validate', () => {
  it('posts ok:true for a valid draft', () => {
    const { actions, posted } = harness();
    actions.validate(VALID);
    expect(posted).toContainEqual({ type: 'validation', ok: true, error: null });
  });

  it('posts ok:false + message for an invalid draft', () => {
    const { actions, posted } = harness();
    actions.validate({ ...VALID, portRange: [9000, 1000] });
    const v = posted.find((m) => m.type === 'validation');
    expect(v).toMatchObject({ type: 'validation', ok: false });
    expect((v as any).error).toMatch(/portRange/);
  });
});

describe('settings actions — save', () => {
  it('writes, reloads, fans out, and re-pushes state + saved (in order)', async () => {
    const { actions, posted, order } = harness();
    await actions.save({ ...VALID, host: '0.0.0.0' });
    expect(order).toEqual(['write', 'reload', 'change']);
    expect(posted.some((m) => m.type === 'state')).toBe(true);
    expect(posted.some((m) => m.type === 'saved')).toBe(true);
  });

  it('does NOT write an invalid draft; posts an error', async () => {
    const { actions, posted, order } = harness();
    await actions.save({ ...VALID, portRange: [9000, 1000] });
    expect(order).toEqual([]); // never wrote
    const e = posted.find((m) => m.type === 'error');
    expect((e as any).message).toMatch(/portRange/);
  });
});

describe('settings actions — section-scoped save', () => {
  /** Capture what actually reached disk, not just that a write happened. */
  function writeSpy() {
    const writes: Manifest[] = [];
    return {
      writes,
      harness: (base: Manifest) =>
        harness({
          loadState: () => ({ manifest: base, error: null }),
          writeManifest: (_p, m) => { writes.push(m); },
        }),
    };
  }

  it('writes only the named section, leaving other tabs as the file has them', async () => {
    const { writes, harness: h } = writeSpy();
    const { actions } = h(VALID);
    // A draft dirty on TWO tabs: only General was asked for.
    await actions.save(
      { ...VALID, host: '0.0.0.0', baselineBranch: 'develop', repositories: {} },
      'general',
    );

    expect(writes).toHaveLength(1);
    expect(writes[0]!.host).toBe('0.0.0.0');
    expect(writes[0]!.baselineBranch).toBe('develop');
    expect(writes[0]!.repositories).toEqual(VALID.repositories); // untouched tab kept
  });

  it('merges onto the CURRENT file, so an out-of-band write is not clobbered', async () => {
    // An agent toggle (setAgentEnabled) landed after the webview loaded its draft.
    const onDisk: Manifest = { ...VALID, agents: { reviewer: { role: 'reviewer', enabled: false } } };
    const { writes, harness: h } = writeSpy();
    const { actions } = h(onDisk);
    await actions.save({ ...VALID, host: '0.0.0.0' }, 'general'); // stale draft: agents {}

    expect(writes[0]!.agents).toEqual(onDisk.agents);
  });

  it('acks with the section it saved', async () => {
    const { actions, posted } = harness();
    await actions.save({ ...VALID, host: '0.0.0.0' }, 'general');
    expect(posted).toContainEqual({ type: 'saved', section: 'general' });
  });

  it('still refuses a merged result that does not validate', async () => {
    const { writes, harness: h } = writeSpy();
    const { actions, posted } = h(VALID);
    await actions.save({ ...VALID, portRange: [9000, 1000] }, 'general');

    expect(writes).toEqual([]);
    expect((posted.find((m) => m.type === 'error') as any).message).toMatch(/portRange/);
  });

  it('falls back to a whole-manifest write when no section is named', async () => {
    const { writes, harness: h } = writeSpy();
    const { actions } = h(VALID);
    const whole: Manifest = { ...VALID, host: '0.0.0.0', worktreePathDisplay: 'absolute' };
    await actions.save(whole);

    expect(writes[0]!.host).toBe('0.0.0.0');
    expect(writes[0]!.worktreePathDisplay).toBe('absolute');
  });
});

describe('settings actions — requestState', () => {
  it('requires the live model catalog dependency', () => {
    expect(MODEL_CATALOG_DEPENDENCY_IS_REQUIRED).toBe(true);
  });

  it('pushes state from loadState (the file), carrying its error', async () => {
    const { actions, posted } = harness({
      loadState: () => ({ manifest: VALID, error: 'portRange min > max' }),
    });
    await actions.requestState();
    const s = posted.find((m) => m.type === 'state');
    expect(s).toBeDefined();
    expect((s as any).state.manifest).toEqual(VALID);
    expect((s as any).state.error).toBe('portRange min > max');
  });

  it('carries installedIds from listInstalledIds', async () => {
    const { actions, posted } = harness({ listInstalledIds: () => ['a', 'b'] });
    await actions.requestState();
    const s = posted.find((m) => m.type === 'state');
    expect((s as any).state.installedIds).toEqual(['a', 'b']);
  });

  it('carries tokenConfigured from hasToken', async () => {
    const { actions, posted } = harness({ hasToken: async () => true });
    await actions.requestState();
    const s = posted.find((m) => m.type === 'state');
    expect((s as any).state.tokenConfigured).toBe(true);
  });

  it('carries the current host model catalog', async () => {
    const { actions, posted } = harness({ modelCatalog: () => REMOTE_MODELS });
    await actions.requestState();
    const s = posted.find((m) => m.type === 'state');
    expect((s as any).state.models).toEqual(REMOTE_MODELS);
  });

  it('reads the live catalog again for later action-driven state pushes', async () => {
    let catalog = REMOTE_MODELS;
    const { actions, posted } = harness({ modelCatalog: () => catalog });
    await actions.requestState();
    catalog = {
      ...REMOTE_MODELS,
      codex: [{ id: 'codex-later', label: 'Codex Later', providers: ['codex'] }],
    };

    await actions.createAgent('reviewer');

    const states = posted.filter((m) => m.type === 'state');
    expect(states).toHaveLength(2);
    expect((states[1] as any).state.models.codex).toEqual([
      { id: 'codex-later', label: 'Codex Later', providers: ['codex'] },
    ]);
  });
});

describe('settings actions — save carries installedIds', () => {
  it('re-pushed state includes installedIds', async () => {
    const { actions, posted } = harness({ listInstalledIds: () => ['x'] });
    await actions.save({ ...VALID, host: '0.0.0.0' });
    const s = posted.find((m) => m.type === 'state');
    expect((s as any).state.installedIds).toEqual(['x']);
  });
});

describe('settings actions — installApproach', () => {
  it('unknown id: posts error, does NOT call installer', () => {
    const { actions, posted, order } = harness();
    actions.installApproach('nope');
    expect(order).not.toContain('install');
    const e = posted.find((m) => m.type === 'error');
    expect((e as any).message).toMatch(/Unknown approach "nope"/);
  });

  it('known id: calls installer with resolved def, re-pushes state with installedIds', async () => {
    let calledWith: unknown;
    const { actions, posted, order } = harness({
      installApproach: async (def) => { calledWith = def; order.push('install'); },
      listInstalledIds: () => ['a'],
    });
    await actions.installApproach('a');
    expect(order).toContain('install');
    expect(calledWith).toEqual(APPROACH_A);
    const s = posted.find((m) => m.type === 'state');
    expect((s as any).state.installedIds).toEqual(['a']);
  });

  it('installer rejects: posts error', async () => {
    const { actions, posted } = harness({
      installApproach: async () => { throw new Error('boom'); },
    });
    await actions.installApproach('a');
    const e = posted.find((m) => m.type === 'error');
    expect((e as any).message).toBe('boom');
  });
});

// An npm-source install shells out `source.command` from the workspace's
// karst.yml (extension.ts's realRunCommand, shell:true). A cloned or shared repo
// therefore runs arbitrary shell on install — the confirm is the only thing
// between the manifest and the shell.
describe('settings actions — installApproach npm-source confirm', () => {
  const npmHarness = (overrides: Partial<SettingsActionsDeps> = {}) =>
    harness({ loadState: () => ({ manifest: NPM_MANIFEST, error: null }), ...overrides });

  it('prompts with the exact command string before installing', async () => {
    const seen: string[] = [];
    const { actions } = npmHarness({
      confirmInstallCommand: async (cmd) => { seen.push(cmd); return true; },
    });
    await actions.installApproach('gsd');
    expect(seen).toEqual(['npx get-shit-done init']);
  });

  it('declined: never reaches the installer', async () => {
    const { actions, order } = npmHarness({ confirmInstallCommand: async () => false });
    await actions.installApproach('gsd');
    expect(order).not.toContain('install');
  });

  it('declined: posts no error — a decline is a choice, not a failure', async () => {
    const { actions, posted } = npmHarness({ confirmInstallCommand: async () => false });
    await actions.installApproach('gsd');
    expect(posted.find((m) => m.type === 'error')).toBeUndefined();
  });

  it('confirmed: installs', async () => {
    const { actions, order } = npmHarness({ confirmInstallCommand: async () => true });
    await actions.installApproach('gsd');
    expect(order).toContain('install');
  });

  it('asks BEFORE running anything', async () => {
    const { actions, order } = npmHarness({
      confirmInstallCommand: async () => { order.push('confirm'); return true; },
    });
    await actions.installApproach('gsd');
    // Not just relative order: assert both ran. `indexOf` on an absent entry is
    // -1, which would satisfy a bare `toBeLessThan` while never prompting at all.
    expect(order).toContain('confirm');
    expect(order).toContain('install');
    expect(order.indexOf('confirm')).toBeLessThan(order.indexOf('install'));
  });

  it('non-npm source: installs with no prompt (nothing shells out)', async () => {
    let asked = false;
    const { actions, order } = harness({
      loadState: () => ({ manifest: { ...VALID, approaches: [APPROACH_SOURCED] }, error: null }),
      confirmInstallCommand: async () => { asked = true; return true; },
    });
    await actions.installApproach('rpi');
    expect(asked).toBe(false);
    expect(order).toContain('install');
  });
});

describe('settings actions — uninstallApproach', () => {
  it('calls uninstaller with id, re-pushes state', async () => {
    let calledWith: string | undefined;
    const { actions, posted, order } = harness({
      uninstallApproach: (id) => { calledWith = id; order.push('uninstall'); return true; },
      listInstalledIds: () => [],
    });
    await actions.uninstallApproach('a');
    expect(order).toContain('uninstall');
    expect(calledWith).toBe('a');
    const s = posted.find((m) => m.type === 'state');
    expect((s as any).state.installedIds).toEqual([]);
  });

  it('uninstaller throws: posts error', async () => {
    const { actions, posted } = harness({
      uninstallApproach: () => { throw new Error('cannot remove'); },
    });
    await actions.uninstallApproach('a');
    const e = posted.find((m) => m.type === 'error');
    expect((e as any).message).toBe('cannot remove');
  });
});

describe('settings actions — setToken', () => {
  it('calls setToken, reports the token flag alone', async () => {
    let hasTok = false;
    const { actions, posted, order } = harness({
      setToken: async () => { hasTok = true; order.push('setToken'); return true; },
      hasToken: async () => hasTok,
    });
    await actions.setToken();
    expect(order).toContain('setToken');
    expect(posted).toContainEqual({ type: 'token-state', configured: true });
  });

  // A full `state` push replaces the webview's draft with the manifest on disk.
  // Setting a token is the FIRST thing a user does while configuring ticketing,
  // long before Save — pushing state there silently reverted the provider they
  // had just picked (and any team id they had typed) to the saved manifest.
  it('does NOT push manifest state, so an unsaved draft survives', async () => {
    const { actions, posted } = harness({
      setToken: async () => true,
      hasToken: async () => true,
    });
    await actions.setToken();
    expect(posted.some((m) => m.type === 'state')).toBe(false);
  });

  it('setToken throws: posts error', async () => {
    const { actions, posted } = harness({
      setToken: async () => { throw new Error('keychain locked'); },
    });
    await actions.setToken();
    const e = posted.find((m) => m.type === 'error');
    expect((e as any).message).toBe('keychain locked');
  });
});

describe('settings actions — setApproachEnabled', () => {
  it('writes a manifest whose approach has enabled:false, re-pushes state', async () => {
    const { actions, posted, order } = harness();
    await actions.setApproachEnabled('a', false);
    expect(order).toEqual(['write', 'reload', 'change']);
    expect(posted.some((m) => m.type === 'state')).toBe(true);
  });

  it('unknown id: posts error, does NOT write', async () => {
    const { actions, posted, order } = harness();
    await actions.setApproachEnabled('nope', false);
    expect(order).not.toContain('write');
    const e = posted.find((m) => m.type === 'error');
    expect((e as any).message).toMatch(/Unknown approach "nope"/);
  });

  it('write throwing posts an error', async () => {
    const { actions, posted } = harness({
      writeManifest: () => { throw new Error('disk full'); },
    });
    await actions.setApproachEnabled('a', false);
    const e = posted.find((m) => m.type === 'error');
    expect((e as any).message).toBe('disk full');
  });

  it('rejects enabling a SOURCED approach that is not installed', async () => {
    const { actions, posted, order } = harness({
      loadState: () => ({ manifest: { ...VALID, approaches: [APPROACH_SOURCED] }, error: null }),
      listInstalledIds: () => [],
    });
    await actions.setApproachEnabled('rpi', true);
    expect(order).not.toContain('write');
    const e = posted.find((m) => m.type === 'error');
    expect((e as any).message).toMatch(/Install "rpi" before enabling it/);
  });

  it('allows enabling a BUILT-IN (sourceless) approach even when not installed', async () => {
    let written: Manifest | undefined;
    const { actions, order } = harness({
      writeManifest: (_p, m) => { written = m; order.push('write'); },
      listInstalledIds: () => [],
    });
    await actions.setApproachEnabled('a', true);
    expect(order).toEqual(['write', 'reload', 'change']);
    expect(written?.approaches?.find((a) => a.id === 'a')?.enabled).toBe(true);
  });

  it('still allows disabling a not-installed approach (cleanup path)', async () => {
    const { actions, order } = harness({ listInstalledIds: () => [] });
    await actions.setApproachEnabled('a', false);
    expect(order).toEqual(['write', 'reload', 'change']);
  });
});

describe('settings actions — setAgentEnabled', () => {
  it('writes agents.reviewer.enabled===false, re-pushes state', async () => {
    let written: Manifest | undefined;
    const { actions, posted, order } = harness({
      writeManifest: (_p, m) => { written = m; order.push('write'); },
    });
    await actions.setAgentEnabled('reviewer', false);
    expect(order).toEqual(['write', 'reload', 'change']);
    expect(written?.agents?.reviewer).toEqual({ role: 'reviewer', enabled: false });
    expect(posted.some((m) => m.type === 'state')).toBe(true);
  });

  it('preserves an existing agent def while flipping enabled', async () => {
    let current: Manifest = { ...VALID, agents: { reviewer: { role: 'reviewer', command: 'claude' } } };
    let written: Manifest | undefined;
    const { actions } = harness({
      loadState: () => ({ manifest: current, error: null }),
      writeManifest: (_p, m) => { written = m; current = m; },
    });
    await actions.setAgentEnabled('reviewer', true);
    expect(written?.agents?.reviewer).toEqual({ role: 'reviewer', command: 'claude', enabled: true });
  });

  it('write throwing posts an error', async () => {
    const { actions, posted } = harness({
      writeManifest: () => { throw new Error('disk full'); },
    });
    await actions.setAgentEnabled('reviewer', false);
    const e = posted.find((m) => m.type === 'error');
    expect((e as any).message).toBe('disk full');
  });
});

describe('settings actions — saveAgentFile', () => {
  it('calls the dep with name and body, re-pushes state', async () => {
    let calledWith: [string, string] | undefined;
    const { actions, posted, order } = harness({
      saveAgentFile: (name, body) => { calledWith = [name, body]; order.push('saveAgentFile'); },
    });
    await actions.saveAgentFile('r', '# body');
    expect(order).toContain('saveAgentFile');
    expect(calledWith).toEqual(['r', '# body']);
    expect(posted.some((m) => m.type === 'state')).toBe(true);
  });

  it('dep throwing posts an error instead of crashing', async () => {
    const { actions, posted } = harness({
      saveAgentFile: () => { throw new Error('traversal rejected'); },
    });
    await actions.saveAgentFile('../evil', 'body');
    const e = posted.find((m) => m.type === 'error');
    expect((e as any).message).toBe('traversal rejected');
  });
});

describe('settings actions — deleteAgent', () => {
  it('calls the dep with name, re-pushes state', async () => {
    let calledWith: string | undefined;
    const { actions, posted, order } = harness({
      deleteAgent: (name) => { calledWith = name; order.push('deleteAgent'); },
    });
    await actions.deleteAgent('r');
    expect(order).toContain('deleteAgent');
    expect(calledWith).toBe('r');
    expect(posted.some((m) => m.type === 'state')).toBe(true);
  });

  it('dep throwing posts an error instead of crashing', async () => {
    const { actions, posted } = harness({
      deleteAgent: () => { throw new Error('boom'); },
    });
    await actions.deleteAgent('r');
    const e = posted.find((m) => m.type === 'error');
    expect((e as any).message).toBe('boom');
  });
});

describe('settings actions — createAgent', () => {
  it('calls writeAgentFile (via createAgent dep) with a non-empty template', async () => {
    let calledWith: string | undefined;
    const { actions, posted, order } = harness({
      createAgent: (name) => { calledWith = name; order.push('createAgent'); },
    });
    await actions.createAgent('r');
    expect(order).toContain('createAgent');
    expect(calledWith).toBe('r');
    expect(posted.some((m) => m.type === 'state')).toBe(true);
  });

  it('dep throwing posts an error instead of crashing', async () => {
    const { actions, posted } = harness({
      createAgent: () => { throw new Error('boom'); },
    });
    await actions.createAgent('r');
    const e = posted.find((m) => m.type === 'error');
    expect((e as any).message).toBe('boom');
  });
});

describe('settings actions — clearToken', () => {
  it('calls clearToken, reports the token flag alone', async () => {
    let hasTok = true;
    const { actions, posted, order } = harness({
      clearToken: async () => { hasTok = false; order.push('clearToken'); },
      hasToken: async () => hasTok,
    });
    await actions.clearToken();
    expect(order).toContain('clearToken');
    expect(posted).toContainEqual({ type: 'token-state', configured: false });
  });

  /** Same draft-preservation rule as setToken. */
  it('does NOT push manifest state, so an unsaved draft survives', async () => {
    const { actions, posted } = harness({
      clearToken: async () => {},
      hasToken: async () => false,
    });
    await actions.clearToken();
    expect(posted.some((m) => m.type === 'state')).toBe(false);
  });

  it('clearToken throws: posts error', async () => {
    const { actions, posted } = harness({
      clearToken: async () => { throw new Error('boom'); },
    });
    await actions.clearToken();
    const e = posted.find((m) => m.type === 'error');
    expect((e as any).message).toBe('boom');
  });
});

describe('settings actions — getApproachCommandBody', () => {
  it('posts a command body for a native command', async () => {
    const { actions, posted } = harness({
      readApproachCommandBody: (id, cmd) => `# ${cmd}\nbody-of-${id}`,
    });
    await actions.getApproachCommandBody('rpi', '/rpi:research');
    expect(posted).toContainEqual({
      type: 'approach-command-body', approachId: 'rpi', command: '/rpi:research', body: '# /rpi:research\nbody-of-rpi',
    });
  });

  it('posts an error (never throws) when a command body cannot be read', async () => {
    const { actions, posted } = harness({
      readApproachCommandBody: () => { throw new Error('no such command'); },
    });
    await actions.getApproachCommandBody('rpi', '/rpi:nope');
    expect(posted.some((m) => m.type === 'error')).toBe(true);
  });
});

describe('fetchTicketStatuses', () => {
  it('posts the provider status names', async () => {
    const { actions, posted } = harness({
      makeProvider: () => ({
        async updateStatus() {},
        async listStatuses() {
          return ['to do', 'in review'];
        },
      }),
    });

    await actions.fetchTicketStatuses('42');

    expect(posted).toContainEqual({
      type: 'ticket-statuses',
      statuses: ['to do', 'in review'],
    });
  });

  it('builds the provider from the draft ids, so Refresh works before Save', async () => {
    const seen: TicketingConfig[] = [];
    const { actions } = harness({
      makeProvider: (config: TicketingConfig): TicketingProvider => {
        seen.push(config);
        return { async updateStatus() {}, async listStatuses() { return []; } };
      },
    });

    await actions.fetchTicketStatuses('99', '9001');

    expect(seen).toEqual([{ provider: 'clickup', listId: '99', teamId: '9001' }]);
  });

  it('posts a status-scoped error, not a panel-level one, when the fetch fails', async () => {
    const { actions, posted } = harness({
      makeProvider: () => ({
        async updateStatus() {},
        async listStatuses(): Promise<string[]> {
          throw new Error('ClickUp: GET /list/42 returned 401');
        },
      }),
    });

    await actions.fetchTicketStatuses('42');

    expect(posted).toContainEqual({
      type: 'ticket-statuses-error',
      message: 'ClickUp: GET /list/42 returned 401',
    });
    expect(posted.some((m) => m.type === 'error')).toBe(false);
  });

  it('reports a provider that cannot list statuses', async () => {
    const { actions, posted } = harness({
      makeProvider: () => ({ async updateStatus() {} }),
    });

    await actions.fetchTicketStatuses('42');

    expect(posted).toContainEqual({
      type: 'ticket-statuses-error',
      message: 'This provider cannot list statuses.',
    });
  });
});

describe('fetchTicketLists', () => {
  it('posts the fetched lists', async () => {
    const { actions, posted } = harness({
      makeProvider: () => ({
        async updateStatus() {},
        async listLists() { return [{ id: '101', name: 'Backlog', space: 'Eng' }]; },
      }),
    });
    await actions.fetchTicketLists('9001');
    expect(posted).toContainEqual({ type: 'ticket-lists', lists: [{ id: '101', name: 'Backlog', space: 'Eng' }] });
  });
  it('posts a list-scoped error on failure, not a panel error', async () => {
    const { actions, posted } = harness({
      makeProvider: () => ({
        async updateStatus() {},
        async listLists(): Promise<never> { throw new Error('ClickUp: GET /team/9001/space returned 401'); },
      }),
    });
    await actions.fetchTicketLists('9001');
    expect(posted).toContainEqual({ type: 'ticket-lists-error', message: 'ClickUp: GET /team/9001/space returned 401' });
    expect(posted.some((m) => m.type === 'error')).toBe(false);
  });
  it('reports a provider that cannot list lists', async () => {
    const { actions, posted } = harness({ makeProvider: () => ({ async updateStatus() {} }) });
    await actions.fetchTicketLists('9001');
    expect(posted).toContainEqual({ type: 'ticket-lists-error', message: 'This provider cannot list lists.' });
  });
});

describe('settings actions — openManifest', () => {
  it('delegates to the injected opener', async () => {
    const { actions, order } = harness();
    await actions.openManifest();
    expect(order).toEqual(['openManifest']);
  });

  it('posts a panel error when the opener rejects', async () => {
    const { actions, posted } = harness({
      openManifest: async () => { throw new Error('no active editor'); },
    });
    await actions.openManifest();
    expect(posted).toContainEqual({ type: 'error', message: 'no active editor' });
  });
});
