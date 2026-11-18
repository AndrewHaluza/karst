import { describe, expect, it } from 'vitest';
import type * as VscodeApi from 'vscode';
import type { AccountRow } from '../agent/accounts/accountOps.js';
import type { SecretStore } from './secretStore.js';
import { REMOVE_SBX_TOKEN_COMMAND, registerSbxOauth, SET_SBX_TOKEN_COMMAND } from './sbxOauthBinding.js';

const TOKEN = 'sk-ant-oat01-abcdefghijkl';
const rows: AccountRow[] = [{ name: 'default', active: true }, { name: 'work', active: false, account: { kind: 'subscription', source: 'managed', dir: '/m' } }];

function setup(opts: { stored?: boolean; registrations?: { key: string; token: string }[] } = {}) {
  const commands = new Map<string, () => unknown>();
  const picks: { items: string[]; placeHolder?: string }[] = [];
  const inputs: { prompt?: string; password?: boolean; ignoreFocusOut?: boolean; validateInput?: (v: string) => unknown }[] = [];
  const map = new Map<string, string>(opts.stored ? [['karst.sbx.token.claude.work', TOKEN]] : []);
  const secrets: SecretStore = { get: async (k) => map.get(k), store: async (k, v) => { map.set(k, v); }, delete: async (k) => { map.delete(k); } };
  const vscode = {
    commands: { registerCommand: (id: string, fn: () => unknown) => { commands.set(id, fn); return { dispose: () => commands.delete(id) }; } },
    window: {
      showQuickPick: async (items: string[], o: { placeHolder?: string }) => { picks.push({ items, ...o }); return items[0]; },
      showInputBox: async (o: (typeof inputs)[number]) => { inputs.push(o); return TOKEN; },
    },
  } as unknown as typeof VscodeApi;
  const spawns: Parameters<NonNullable<Parameters<typeof registerSbxOauth>[0]['spawn']>>[0][] = [];
  const infos: string[] = [];
  const subscriptions: { dispose(): unknown }[] = [];
  const debug: string[] = [];
  const reg = registerSbxOauth({
    vscode, secrets, accounts: { listAccounts: async () => rows }, notify: { info: (m) => { infos.push(m); }, warn: () => {}, error: async () => {} },
    globalStorageRoot: '/gs', extensionPath: '/ext', subscriptions, liveRegistrations: async () => opts.registrations ?? [], debug: (m) => debug.push(m),
    spawn: (i) => { spawns.push(i); },
  });
  return { commands, picks, inputs, map, spawns, infos, subscriptions, debug, reg };
}
const tick = () => new Promise((r) => setTimeout(r, 20));

describe('sbx oauth binding', () => {
  it('registers both commands and a dispose for the probe timer', () => {
    const s = setup();
    expect(SET_SBX_TOKEN_COMMAND).toBe('karst.sbx.setClaudeToken');
    expect(REMOVE_SBX_TOKEN_COMMAND).toBe('karst.sbx.removeClaudeToken');
    expect([...s.commands.keys()]).toEqual([SET_SBX_TOKEN_COMMAND, REMOVE_SBX_TOKEN_COMMAND]);
    expect(s.subscriptions).toHaveLength(3);
    s.subscriptions.forEach((d) => d.dispose());
  });

  it('picks the account in a quick pick and asks for the token in a masked input that checks the prefix', async () => {
    const s = setup();
    await s.commands.get(SET_SBX_TOKEN_COMMAND)!();
    expect(s.picks).toEqual([{ items: ['work'], placeHolder: 'Claude account to set the sbx token for' }]);
    expect(s.inputs[0]).toMatchObject({ prompt: "Subscription token for the Claude account 'work' (from 'claude setup-token'; kept in your OS keychain)", password: true, ignoreFocusOut: true });
    expect(s.inputs[0]!.validateInput!('nope')).toMatch(/sk-ant-oat01-/);
    expect(s.inputs[0]!.validateInput!(TOKEN)).toBeNull();
    expect(s.map.get('karst.sbx.token.claude.work')).toBe(TOKEN);
    s.subscriptions.forEach((d) => d.dispose());
  });

  it('starts the detached proxy with this editor paths after a token is set', async () => {
    const s = setup();
    await s.commands.get(SET_SBX_TOKEN_COMMAND)!();
    await tick();
    expect(s.spawns).toHaveLength(1);
    const spawn = s.spawns[0]!;
    expect(spawn.script).toBe('/ext/dist/oauth-proxy/oauth-proxy.mjs');
    expect(spawn.logFile).toBe('/gs/oauth-proxy.log');
    expect(spawn.paths.portFile).toBe('/gs/oauth-proxy.port');
    expect(spawn.paths.socketPath).toContain('karst-oauth-');
    spawn.onError!('x');
    expect(s.debug).toContain('x');
    s.subscriptions.forEach((d) => d.dispose());
  });

  it('removes a token without starting the proxy', async () => {
    const s = setup({ stored: true });
    await tick();
    s.spawns.length = 0; // the activation start
    await s.commands.get(REMOVE_SBX_TOKEN_COMMAND)!();
    expect(s.picks[0]!.placeHolder).toBe('Claude account to remove the sbx token from');
    expect(s.map.size).toBe(0);
    await tick();
    expect(s.spawns).toHaveLength(0);
    s.subscriptions.forEach((d) => d.dispose());
  });

  it('starts the proxy at activation when an account has a token, and not otherwise', async () => {
    const a = setup({ stored: true }); await tick();
    expect(a.spawns).toHaveLength(1);
    const b = setup(); await tick();
    expect(b.spawns).toHaveLength(0);
    [a, b].forEach((s) => s.subscriptions.forEach((d) => d.dispose()));
  });
});
