import { describe, expect, it, vi } from 'vitest';
import type * as VscodeApi from 'vscode';
import type { SecretStore } from './secretStore.js';

const client = vi.hoisted(() => ({
  health: vi.fn(async () => true),
  register: vi.fn(async (_k: string, _t: string) => undefined),
  revoke: vi.fn(async (_k: string) => undefined),
  readPort: vi.fn(async () => 4321 as number | undefined),
}));
const sbx = vi.hoisted(() => ({ run: vi.fn(async (_bin: string, _args: string[]) => ({ code: 0, stdout: '', stderr: '' })) }));
vi.mock('../agent/oauthProxy/client.js', async (orig) => ({ ...(await orig<typeof import('../agent/oauthProxy/client.js')>()), createProxyClient: () => client }));
vi.mock('../agent/sbx/sbxProcess.js', () => ({ NODE_SBX_PROCESS: sbx }));

const { registerSbxOauth, REMOVE_SBX_TOKEN_COMMAND } = await import('./sbxOauthBinding.js');
const TOKEN = 'sk-ant-oat01-abcdefghijkl';
const rows = [{ name: 'default', active: true }, { name: 'work', active: false, account: { kind: 'subscription' as const, source: 'managed' as const, dir: '/m' } }];

function setup(opts: { failGrantWrite?: boolean } = {}) {
  const commands = new Map<string, () => unknown>();
  const map = new Map<string, string>([
    ['karst.sbx.token.claude.work', TOKEN],
    ['karst.sbx.grant.sb', JSON.stringify({ key: 'key-1', account: 'work', port: 4321 })],
    ['karst.sbx.grants.index', JSON.stringify(['sb'])],
  ]);
  const secrets: SecretStore = {
    get: async (k) => map.get(k),
    store: async (k, v) => { if (opts.failGrantWrite && k.startsWith('karst.sbx.grant.')) throw new Error('disk'); map.set(k, v); },
    delete: async (k) => { map.delete(k); },
  };
  const vscode = {
    commands: { registerCommand: (id: string, fn: () => unknown) => { commands.set(id, fn); return { dispose: () => undefined }; } },
    window: { showQuickPick: async (items: string[]) => items[0], showInputBox: async () => TOKEN },
  } as unknown as typeof VscodeApi;
  const debug: string[] = [];
  const subscriptions: { dispose(): unknown }[] = [];
  const reg = registerSbxOauth({
    vscode, secrets, accounts: { listAccounts: async () => rows }, notify: { info: () => {}, warn: () => {}, error: async () => {} },
    globalStorageRoot: '/gs', grantLock: async (section) => section(), extensionPath: '/ext', subscriptions, debug: (m) => debug.push(m), spawn: () => {},
  });
  return { commands, map, debug, reg, subscriptions };
}
const tick = () => new Promise((r) => setTimeout(r, 20));

describe('sbx oauth binding grants', () => {
  it('re-registers the live keys of its own grant store after a proxy restart', async () => {
    const s = setup();
    await tick();
    client.register.mockClear();
    await s.reg.lifecycle.probe();
    expect(client.register).toHaveBeenCalledWith('key-1', TOKEN);
    s.subscriptions.forEach((d) => d.dispose());
  });

  it('hands the launch resolver the accounts with a stored token, read through its own account list and store', async () => {
    const s = setup();
    const input = await s.reg.oauthInput();
    expect([...input.tokenAccounts]).toEqual(['work']);
    expect(input.grants).toBe(s.reg.grants);
    s.subscriptions.forEach((d) => d.dispose());
  });

  it('issues a key through its grant store and the proxy of this window', async () => {
    const s = setup();
    const out = await s.reg.grants.issue('sb2', 'work');
    expect(out).toMatchObject({ ok: true, port: 4321 });
    s.subscriptions.forEach((d) => d.dispose());
  });

  it('removing a token revokes the live key of the account at the proxy', async () => {
    const s = setup();
    client.revoke.mockClear();
    await s.commands.get(REMOVE_SBX_TOKEN_COMMAND)!();
    await tick();
    expect(client.revoke).toHaveBeenCalledWith('key-1');
    s.subscriptions.forEach((d) => d.dispose());
  });

  it('logs, without detail, when the keys of a removed token cannot be revoked', async () => {
    const s = setup({ failGrantWrite: true });
    await s.commands.get(REMOVE_SBX_TOKEN_COMMAND)!();
    await tick();
    expect(s.debug).toContain('[oauth-proxy] revoke of the keys of work failed: error');
    s.subscriptions.forEach((d) => d.dispose());
  });

  it('releaseGrant revokes the key and runs the policy rm through sbx', async () => {
    const s = setup();
    client.revoke.mockClear();
    sbx.run.mockClear();
    await s.reg.releaseGrant('sb');
    expect(client.revoke).toHaveBeenCalledWith('key-1');
    expect(sbx.run).toHaveBeenCalledWith('sbx', expect.arrayContaining(['policy', 'rm', 'sb']));
    s.subscriptions.forEach((d) => d.dispose());
  });
});
