import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAccountOps } from './accountOps.js';
import { memoryAccountStore } from './accountStore.js';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'acct-ops-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function setup(over: { live?: string[]; resolves?: boolean; signed?: boolean | undefined } = {}) {
  const store = memoryAccountStore();
  const debug: string[] = [];
  const ops = createAccountOps({
    store, managedRoot: join(root, 'accounts'), home: '/home/u',
    defaultDir: (c) => join(root, 'default', c),
    liveAccounts: async () => over.live ?? [],
    binaryResolves: async () => over.resolves ?? true,
    lookupAlias: async () => '',
    signedIn: async () => over.signed,
    debug: (m) => debug.push(m),
  });
  return { store, ops, debug };
}

describe('account ops', () => {
  it('lists default first and marks it active with no accounts', async () => {
    const { ops } = setup();
    expect(await ops.listAccounts('claude')).toEqual([{ name: 'default', active: true }]);
  });

  it('creates a managed account under the managed root with a 0700 folder', async () => {
    const { ops, store } = setup();
    await ops.createAccount('claude', 'work', { source: 'managed' });
    const dir = join(root, 'accounts', 'claude', 'work');
    expect((await stat(dir)).isDirectory()).toBe(true);
    expect(store.current().claude?.list.work?.dir).toBe(dir);
  });

  it('rejects a bad slug and a duplicate name', async () => {
    const { ops } = setup();
    await expect(ops.createAccount('claude', '../x', { source: 'managed' })).rejects.toThrow();
    await ops.createAccount('claude', 'a', { source: 'managed' });
    await expect(ops.createAccount('claude', 'a', { source: 'managed' })).rejects.toThrow(/already exists/);
  });

  it('sets the active account and refuses an unknown one', async () => {
    const { ops, store } = setup();
    await ops.createAccount('codex', 'c', { source: 'folder', dir: '/h/c' });
    await ops.setActive('codex', 'c');
    expect(store.current().codex?.active).toBe('c');
    await ops.setActive('codex', 'default');
    expect(store.current().codex?.active).toBe('default');
    await expect(ops.setActive('codex', 'zz')).rejects.toThrow();
  });

  it('refuses to delete default or an account with a live session; deletes a managed folder', async () => {
    const live = setup({ live: ['w'] });
    await live.ops.createAccount('claude', 'w', { source: 'managed' });
    await expect(live.ops.deleteAccount('claude', 'w')).rejects.toThrow(/live session/);
    await expect(live.ops.deleteAccount('claude', 'default')).rejects.toThrow(/default/);
    const { ops, store } = setup();
    await ops.createAccount('claude', 'w', { source: 'managed' });
    await ops.setActive('claude', 'w');
    await ops.deleteAccount('claude', 'w');
    expect(store.current().claude?.active).toBe('default');
    await expect(stat(join(root, 'accounts', 'claude', 'w'))).rejects.toThrow();
  });

  it('keeps the files of a folder account on delete', async () => {
    const { ops } = setup();
    await ops.createAccount('claude', 'f', { source: 'folder', dir: root });
    await ops.deleteAccount('claude', 'f');
    expect((await stat(root)).isDirectory()).toBe(true);
  });

  it('builds the login command under the account env', async () => {
    const { ops } = setup();
    await ops.createAccount('claude', 'w', { source: 'folder', dir: '/h/w' });
    const login = await ops.loginCommand('claude', 'w');
    expect(login.binary).toBe('claude');
    expect(login.args).toEqual(['/login']);
    expect(login.env.CLAUDE_CONFIG_DIR).toBe('/h/w');
    expect((await ops.loginCommand('codex')).env).toEqual({});
  });

  it('reports account status from the probe', async () => {
    expect(await setup({ signed: true }).ops.accountStatus('claude', 'default')).toBe('signed-in');
    expect(await setup({ signed: false }).ops.accountStatus('claude', 'default')).toBe('not-signed-in');
    expect(await setup().ops.accountStatus('claude', 'default')).toBe('unknown');
  });

  it('validates the binary and the folder', async () => {
    const { ops } = setup({ resolves: false });
    await ops.createAccount('claude', 'f', { source: 'folder', dir: join(root, 'missing') });
    const problems = await ops.validateAccount('claude', 'f');
    expect(problems).toHaveLength(2);
    expect(await setup().ops.validateAccount('claude', 'default')).toEqual([]);
  });

  it('imports an alias and stores it; refuses a complex alias without storing', async () => {
    const { ops, store, debug } = setup();
    const ok = await ops.importShellAlias('claude', 'claude-work', `claude-work='CLAUDE_CONFIG_DIR="$HOME/.cw" claude'`);
    expect(ok.ok).toBe(true);
    expect(store.current().claude?.list['claude-work']?.dir).toBe('/home/u/.cw');
    const bad = await ops.importShellAlias('claude', 'x', `x='a && b'`);
    expect(bad.ok).toBe(false);
    expect(store.current().claude?.list.x).toBeUndefined();
    expect(debug.join('\n')).not.toMatch(/TOKEN|SECRET/);
  });

  it('copies seed items into a stored target only', async () => {
    const { ops } = setup();
    await ops.createAccount('claude', 'w', { source: 'managed' });
    const r = await ops.copyAccountSeed('claude', 'w', ['settings']);
    expect(r.skipped[0]?.reason).toMatch(/not present/);
    await expect(ops.copyAccountSeed('claude', 'default', ['settings'])).rejects.toThrow();
  });
});

describe('alias import keeps the arguments', () => {
  it('stores args for a folder account (the alias uses the default binary)', async () => {
    const { ops, store } = setup();
    const r = await ops.importShellAlias('claude', 'cw', `cw='CLAUDE_CONFIG_DIR="$HOME/.cw" claude --model opus'`);
    expect(r.ok).toBe(true);
    expect(store.current().claude?.list.cw).toMatchObject({ source: 'folder', args: ['--model', 'opus'] });
  });
});
