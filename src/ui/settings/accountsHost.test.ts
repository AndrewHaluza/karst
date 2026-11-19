import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAccountOps } from '../../agent/accounts/accountOps.js';
import { memoryAccountStore } from '../../agent/accounts/accountStore.js';
import { createAccountsHost, SBX_TOKEN_STORE_FAILED, type SbxTokenDeps } from './accountsHost.js';
import type { AccountsHostMessage } from './accountsMessages.js';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'acct-host-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function setup(over: { slug?: string; live?: string[]; signed?: boolean | undefined; alias?: string; tokens?: Partial<SbxTokenDeps> & { stored?: Map<string, string> } } = {}) {
  const stored = over.tokens?.stored ?? new Map<string, string>();
  const changed: string[] = [];
  const ops = createAccountOps({
    store: memoryAccountStore(), managedRoot: join(root, 'accounts'), home: '/home/u',
    defaultDir: (c) => join(root, 'default', c),
    liveAccounts: async () => over.live ?? [],
    binaryResolves: async () => true,
    lookupAlias: async () => over.alias ?? '',
    signedIn: async () => over.signed,
    ...(over.slug !== undefined ? { projectSlug: () => over.slug } : {}),
  });
  const posted: AccountsHostMessage[] = [];
  const logins: Array<{ binary: string; args: string[] }> = [];
  const host = createAccountsHost({
    ops,
    post: (m) => posted.push(m),
    openLogin: (core, name, cmd) => { logins.push({ binary: cmd.binary, args: cmd.args }); void core; void name; },
    pickFolder: async () => '/picked',
    ...(over.tokens ? {
      sbxToken: {
        has: async (n: string) => stored.has(n),
        ask: async () => 'sk-ant-oat01-abcdefghij',
        store: async (n: string, t: string) => { stored.set(n, t); },
        remove: async (n: string) => { stored.delete(n); },
        onChanged: (n: string, c: string) => changed.push(`${n}:${c}`),
        ...over.tokens,
      },
    } : {}),
  });
  return { host, posted, logins, ops, stored, changed };
}

describe('accounts host', () => {
  it('lists every core with default first, labelled, and no env or secrets', async () => {
    const { host, posted, ops } = setup({ signed: true });
    await ops.createAccount('claude', 'work', { source: 'command', command: 'claude', dir: '/h/w', env: { CLAUDE_CONFIG_DIR: '/h/w' } });
    await host.handle({ type: 'accounts-load' });
    const msg = posted[0];
    expect(msg?.type).toBe('accounts-state');
    if (msg?.type !== 'accounts-state') return;
    expect(msg.cores.map((c) => c.core)).toEqual(['claude', 'codex', 'opencode', 'opencode2', 'antigravity']);
    const claude = msg.cores[0]!;
    expect(claude.rows[0]).toMatchObject({ name: 'default', label: 'Default (CLI home)', builtIn: true, active: true, status: 'signed-in' });
    expect(claude.rows[1]).toMatchObject({ name: 'work', source: 'command', command: 'claude', dir: '/h/w' });
    expect(JSON.stringify(msg)).not.toContain('CLAUDE_CONFIG_DIR');
  });

  it('reports unknown when the probe has no answer', async () => {
    const { host, posted } = setup();
    await host.handle({ type: 'accounts-load' });
    const msg = posted[0];
    if (msg?.type !== 'accounts-state') throw new Error('state');
    expect(msg.cores[0]!.rows[0]!.status).toBe('unknown');
  });

  it('adds an account, then pushes state', async () => {
    const { host, posted } = setup({ signed: false });
    await host.handle({ type: 'accounts-add', core: 'claude', name: 'w', spec: { source: 'managed' } });
    expect(posted.map((m) => m.type)).toEqual(['accounts-added', 'accounts-state']);
    expect(posted[0]).toMatchObject({ name: 'w', status: 'not-signed-in' });
  });

  it('reports a refused add with the reason and stores nothing', async () => {
    const { host, posted, ops } = setup();
    await host.handle({ type: 'accounts-add', core: 'claude', name: '../x', spec: { source: 'managed' } });
    expect(posted[0]).toMatchObject({ type: 'accounts-error', op: 'accounts-add', core: 'claude' });
    expect((await ops.listAccounts('claude')).length).toBe(1);
  });

  it('imports an alias from pasted text and shows env keys only', async () => {
    const { host, posted } = setup({ signed: true });
    await host.handle({ type: 'accounts-import-alias', core: 'claude', alias: 'claude-work', text: "alias claude-work='CLAUDE_CONFIG_DIR=$HOME/.claude-work claude'" });
    expect(posted[0]).toMatchObject({ type: 'accounts-alias-result', ok: true, status: 'signed-in' });
    const r = posted[0];
    if (r?.type !== 'accounts-alias-result' || !r.ok) throw new Error('ok');
    expect(r.account.envKeys).toEqual(['CLAUDE_CONFIG_DIR']);
    expect(r.account.dir).toBe('/home/u/.claude-work');
    expect(posted[1]?.type).toBe('accounts-state');
  });

  it('shows the refusal reason of a bad alias', async () => {
    const { host, posted } = setup({ alias: "alias x='a | b'" });
    await host.handle({ type: 'accounts-import-alias', core: 'claude', alias: 'x' });
    expect(posted[0]).toMatchObject({ type: 'accounts-alias-result', ok: false });
    const r = posted[0];
    if (r?.type === 'accounts-alias-result' && !r.ok) expect(r.reason.length).toBeGreaterThan(0);
  });

  it('sets the active account and refuses an unknown one', async () => {
    const { host, posted } = setup();
    await host.handle({ type: 'accounts-set-active', core: 'codex', name: 'nope' });
    expect(posted[0]).toMatchObject({ type: 'accounts-error', op: 'accounts-set-active' });
  });

  it('refuses to delete an account used by a live session, with the reason', async () => {
    const { host, posted, ops } = setup({ live: ['w'] });
    await ops.createAccount('claude', 'w', { source: 'managed' });
    await host.handle({ type: 'accounts-delete', core: 'claude', name: 'w', removeFolder: true });
    expect(posted[0]).toMatchObject({ type: 'accounts-error', op: 'accounts-delete' });
    const e = posted[0];
    if (e?.type === 'accounts-error') expect(e.message).toMatch(/live session/);
  });

  it('deletes an account and pushes state', async () => {
    const { host, posted, ops } = setup();
    await ops.createAccount('claude', 'w', { source: 'managed' });
    await host.handle({ type: 'accounts-delete', core: 'claude', name: 'w', removeFolder: false });
    expect(posted.map((m) => m.type)).toEqual(['accounts-state']);
  });

  it('sends the seed checklist from the host with host-owned labels', async () => {
    const { host, posted, ops } = setup();
    await ops.createAccount('claude', 'w', { source: 'managed' });
    await ops.createAccount('claude', 'f', { source: 'folder', dir: root });
    await host.handle({ type: 'accounts-seed-items', core: 'claude', name: 'w' });
    await host.handle({ type: 'accounts-seed-items', core: 'claude', name: 'f' });
    const [m, f] = posted;
    if (m?.type !== 'accounts-seed' || f?.type !== 'accounts-seed') throw new Error('seed');
    expect(m.items.some((i) => i.checked)).toBe(true);
    expect(f.items.length).toBeGreaterThan(0);
    expect(f.items.every((i) => !i.checked)).toBe(true);
  });

  it('sends an empty checklist for opencode', async () => {
    const { host, posted, ops } = setup();
    await ops.createAccount('opencode', 'w', { source: 'managed' });
    await host.handle({ type: 'accounts-seed-items', core: 'opencode', name: 'w' });
    expect(posted[0]).toMatchObject({ type: 'accounts-seed', items: [] });
  });

  it('copies the selected items and reports the result', async () => {
    const { host, posted, ops } = setup();
    await ops.createAccount('claude', 'w', { source: 'managed' });
    await host.handle({ type: 'accounts-copy-seed', core: 'claude', name: 'w', items: ['settings'] });
    expect(posted[0]).toMatchObject({ type: 'accounts-copy-result', core: 'claude', name: 'w' });
  });

  it('opens the login terminal with the account command', async () => {
    const { host, logins, ops } = setup();
    await ops.createAccount('claude', 'w', { source: 'command', command: 'claude-w', dir: '/h/w' });
    await host.handle({ type: 'accounts-login', core: 'claude', name: 'w' });
    expect(logins).toEqual([{ binary: 'claude-w', args: ['/login'] }]);
  });

  it('answers the folder picker', async () => {
    const { host, posted } = setup();
    await host.handle({ type: 'accounts-pick-folder' });
    expect(posted[0]).toEqual({ type: 'accounts-folder-picked', path: '/picked' });
  });

  describe('sbx token (D651)', () => {
    const rowsOf = (m: AccountsHostMessage | undefined) => {
      if (m?.type !== 'accounts-state') throw new Error('state');
      return m.cores.find((c) => c.core === 'claude')!.rows;
    };

    it('reports set / not-set for folder and managed Claude rows only', async () => {
      const { host, posted, ops } = setup({ tokens: {}, signed: true });
      await ops.createAccount('claude', 'w', { source: 'managed' });
      await ops.createAccount('claude', 'f', { source: 'folder', dir: root });
      await ops.createAccount('claude', 'c', { source: 'command', command: 'claude', dir: '/h/c' });
      await ops.createAccount('codex', 'cx', { source: 'managed' });
      await host.handle({ type: 'accounts-load' });
      const rows = rowsOf(posted[0]);
      expect(rows.map((r) => [r.name, r.sbxToken])).toEqual([['default', undefined], ['w', 'not-set'], ['f', 'not-set'], ['c', undefined]]);
      const first = posted[0];
      if (first?.type !== 'accounts-state') throw new Error('state');
      const codex = first.cores.find((c) => c.core === 'codex')!;
      expect(codex.rows.every((r) => r.sbxToken === undefined)).toBe(true);
    });

    it('sends no token state without the token seam', async () => {
      const { host, posted, ops } = setup();
      await ops.createAccount('claude', 'w', { source: 'managed' });
      await host.handle({ type: 'accounts-load' });
      expect(rowsOf(posted[0]).every((r) => r.sbxToken === undefined)).toBe(true);
    });

    it('asks the host for the token, stores it and pushes state without the value', async () => {
      const { host, posted, ops, stored, changed } = setup({ tokens: {} });
      await ops.createAccount('claude', 'w', { source: 'managed' });
      await host.handle({ type: 'accounts-set-sbx-token', core: 'claude', name: 'w' });
      expect(stored.get('w')).toBe('sk-ant-oat01-abcdefghij');
      expect(changed).toEqual(['w:set']);
      expect(rowsOf(posted[0]).find((r) => r.name === 'w')?.sbxToken).toBe('set');
      expect(JSON.stringify(posted)).not.toContain('abcdefghij');
    });

    it('stores nothing and pushes state when the user cancels the input box', async () => {
      const { host, posted, ops, stored } = setup({ tokens: { ask: async () => undefined } });
      await ops.createAccount('claude', 'w', { source: 'managed' });
      await host.handle({ type: 'accounts-set-sbx-token', core: 'claude', name: 'w' });
      expect(stored.size).toBe(0);
      expect(posted.map((m) => m.type)).toEqual(['accounts-state', 'accounts-token-done']);
    });

    it('refuses a bad prefix with a fixed message and stores nothing', async () => {
      const { host, posted, ops, stored } = setup({ tokens: { ask: async () => 'sk-ant-api03-wrong-kind' } });
      await ops.createAccount('claude', 'w', { source: 'managed' });
      await host.handle({ type: 'accounts-set-sbx-token', core: 'claude', name: 'w' });
      expect(stored.size).toBe(0);
      expect(posted[0]).toMatchObject({ type: 'accounts-error', op: 'accounts-set-sbx-token', core: 'claude' });
      expect(JSON.stringify(posted)).not.toContain('wrong-kind');
    });

    it('maps a store failure to a fixed message that holds no raw error', async () => {
      const { host, posted, ops } = setup({ tokens: { store: async () => { throw new Error('keychain locked sk-ant-oat01-abcdefghij'); } } });
      await ops.createAccount('claude', 'w', { source: 'managed' });
      await host.handle({ type: 'accounts-set-sbx-token', core: 'claude', name: 'w' });
      expect(posted).toEqual([{ type: 'accounts-error', op: 'accounts-set-sbx-token', core: 'claude', message: SBX_TOKEN_STORE_FAILED }]);
    });

    it('refuses the default, a command account and an unknown account', async () => {
      const { host, posted, ops, stored } = setup({ tokens: {} });
      await ops.createAccount('claude', 'c', { source: 'command', command: 'claude', dir: '/h/c' });
      for (const name of ['default', 'c', 'ghost']) await host.handle({ type: 'accounts-set-sbx-token', core: 'claude', name });
      expect(posted.map((m) => m.type)).toEqual(['accounts-error', 'accounts-error', 'accounts-error']);
      expect(stored.size).toBe(0);
    });

    it('removes a token, tells the wiring and pushes state', async () => {
      const { host, posted, ops, stored, changed } = setup({ tokens: { stored: new Map([['w', 'sk-ant-oat01-abcdefghij']]) } });
      await ops.createAccount('claude', 'w', { source: 'managed' });
      await host.handle({ type: 'accounts-remove-sbx-token', core: 'claude', name: 'w' });
      expect(stored.size).toBe(0);
      expect(changed).toEqual(['w:removed']);
      expect(rowsOf(posted[0]).find((r) => r.name === 'w')?.sbxToken).toBe('not-set');
    });

    it('reports a failed remove with a fixed message', async () => {
      const { host, posted, ops } = setup({ tokens: { remove: async () => { throw new Error('boom'); } } });
      await ops.createAccount('claude', 'w', { source: 'managed' });
      await host.handle({ type: 'accounts-remove-sbx-token', core: 'claude', name: 'w' });
      expect(posted).toEqual([{ type: 'accounts-error', op: 'accounts-remove-sbx-token', core: 'claude', message: 'The sbx token was not removed.' }]);
    });

    it('says the store is unavailable when the seam is absent', async () => {
      const { host, posted, ops } = setup();
      await ops.createAccount('claude', 'w', { source: 'managed' });
      await host.handle({ type: 'accounts-set-sbx-token', core: 'claude', name: 'w' });
      expect(posted[0]).toMatchObject({ type: 'accounts-error', message: 'The sbx token store is not available.' });
    });
  });
});

describe('accounts host: per-project active account', () => {
  async function stateOf(h: ReturnType<typeof setup>) {
    h.posted.length = 0;
    await h.host.handle({ type: 'accounts-load' });
    const msg = h.posted[0];
    if (msg?.type !== 'accounts-state') throw new Error('no state');
    return msg.cores[0]!;
  }
  it('sends active, machineDefault and source per core', async () => {
    const h = setup({ slug: 'alpha' });
    await h.ops.createAccount('claude', 'work', { source: 'managed' });
    expect(await stateOf(h)).toMatchObject({ active: 'default', machineDefault: 'default', source: 'machine' });
    await h.host.handle({ type: 'accounts-set-machine-default', core: 'claude', name: 'work' });
    expect(await stateOf(h)).toMatchObject({ active: 'work', machineDefault: 'work', source: 'machine' });
    await h.host.handle({ type: 'accounts-set-active', core: 'claude', name: 'default' });
    expect(await stateOf(h)).toMatchObject({ active: 'default', machineDefault: 'work', source: 'project' });
    await h.host.handle({ type: 'accounts-clear-project-choice', core: 'claude' });
    expect(await stateOf(h)).toMatchObject({ active: 'work', machineDefault: 'work', source: 'machine' });
  });
  it('replies with an error for a refused machine default', async () => {
    const h = setup({ slug: 'alpha' });
    h.posted.length = 0;
    await h.host.handle({ type: 'accounts-set-machine-default', core: 'claude', name: 'nope' });
    expect(h.posted[0]).toMatchObject({ type: 'accounts-error', op: 'accounts-set-machine-default', core: 'claude' });
  });
});
