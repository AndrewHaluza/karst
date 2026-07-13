import { describe, it, expect } from 'vitest';
import { buildSettingsActions, type SettingsActionsDeps } from './actions.js';
import type { SettingsHostMessage } from './messages.js';
import type { Manifest, ApproachDef } from '../../manifest/types.js';

const APPROACH_A: ApproachDef = { id: 'a', label: 'Approach A' };
/** A sourced (git) approach: enabling it requires an installed package. */
const APPROACH_SOURCED: ApproachDef = {
  id: 'rpi',
  label: 'RPI',
  source: { type: 'git', repo: 'owner/rpi', ref: 'main', include: ['prompts/'] },
};

const VALID: Manifest = {
  host: 'localhost',
  portRange: [4000, 4999],
  baselineBranch: 'develop',
  services: {
    api: {
      repoPath: '../api', start: 'npm run dev',
      ports: [{ name: 'port', env: 'PORT', default: 3000 }],
      dependsOn: [], hasMigrations: false, signals: [],
    },
  },
  approaches: [APPROACH_A], agents: {}, worktreePathDisplay: 'relative',
};

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
    ...overrides,
  };
  const factory = buildSettingsActions(deps);
  const actions = factory({ post: (m) => posted.push(m), manifestPath: '/tmp/karst.yml' });
  return { actions, posted, order };
}

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

describe('settings actions — requestState', () => {
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
  it('calls setToken, re-pushes state with tokenConfigured true', async () => {
    let hasTok = false;
    const { actions, posted, order } = harness({
      setToken: async () => { hasTok = true; order.push('setToken'); return true; },
      hasToken: async () => hasTok,
    });
    await actions.setToken();
    expect(order).toContain('setToken');
    const s = posted.find((m) => m.type === 'state');
    expect((s as any).state.tokenConfigured).toBe(true);
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
  it('calls clearToken, re-pushes state with tokenConfigured false', async () => {
    let hasTok = true;
    const { actions, posted, order } = harness({
      clearToken: async () => { hasTok = false; order.push('clearToken'); },
      hasToken: async () => hasTok,
    });
    await actions.clearToken();
    expect(order).toContain('clearToken');
    const s = posted.find((m) => m.type === 'state');
    expect((s as any).state.tokenConfigured).toBe(false);
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
