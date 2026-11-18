import { describe, expect, it } from 'vitest';
import type { AccountRow } from '../../agent/accounts/accountOps.js';
import type { SecretStore } from '../secretStore.js';
import { createSbxTokenOps } from './sbxTokenOps.js';

const TOKEN = 'sk-ant-oat01-abcdefghijkl';
const rows: AccountRow[] = [
  { name: 'default', active: true },
  { name: 'work', active: false, account: { kind: 'subscription', source: 'managed', dir: '/m' } },
  { name: 'home', active: false, account: { kind: 'subscription', source: 'folder', dir: '/h' } },
  { name: 'cmd', active: false, account: { kind: 'subscription', source: 'command', command: 'x', dir: '/c' } },
];

function setup(over: { token?: string | undefined; pick?: string | undefined; accounts?: AccountRow[] } = {}) {
  const map = new Map<string, string>();
  const secrets: SecretStore = { get: async (k) => map.get(k), store: async (k, v) => { map.set(k, v); }, delete: async (k) => { map.delete(k); } };
  const out = { infos: [] as string[], warns: [] as string[], offered: [] as string[][], changed: [] as string[], asked: [] as string[] };
  const ops = createSbxTokenOps({
    secrets,
    listAccounts: async () => over.accounts ?? rows,
    pickAccount: async (names) => { out.offered.push([...names]); return 'pick' in over ? over.pick : 'work'; },
    askToken: async (a) => { out.asked.push(a); return 'token' in over ? over.token : TOKEN; },
    notify: { info: (m) => { out.infos.push(m); }, warn: (m) => { out.warns.push(m); }, error: async () => {} },
    onChanged: (a, c) => out.changed.push(`${a}:${c}`),
  });
  return { ops, map, out };
}

describe('sbx token commands', () => {
  it('offers only folder and managed accounts, stores the token and announces it', async () => {
    const { ops, map, out } = setup();
    await ops.set();
    expect(out.offered).toEqual([['work', 'home']]);
    expect(out.asked).toEqual(['work']);
    expect(map.get('karst.sbx.token.claude.work')).toBe(TOKEN);
    expect(out.changed).toEqual(['work:set']);
    expect(out.infos).toEqual(["The sbx token for the Claude account 'work' is stored."]);
    expect(out.infos.join()).not.toContain(TOKEN);
  });

  it('warns when no account can hold a token', async () => {
    const { ops, out } = setup({ accounts: [rows[0]!, rows[3]!] });
    await ops.set();
    expect(out.warns).toEqual(['No Claude account can hold an sbx token. Add a folder or managed account first.']);
    expect(out.asked).toEqual([]);
  });

  it('stops without a message when the user cancels the pick or the input', async () => {
    const a = setup({ pick: undefined }); await a.ops.set();
    expect(a.out.asked).toEqual([]);
    const b = setup({ token: undefined }); await b.ops.set();
    expect(b.map.size).toBe(0);
    expect([...a.out.infos, ...a.out.warns, ...b.out.infos, ...b.out.warns]).toEqual([]);
  });

  it('warns with the reason and stores nothing for a bad token', async () => {
    const { ops, map, out } = setup({ token: 'sk-ant-api03-abcdefghijkl' });
    await ops.set();
    expect(map.size).toBe(0);
    expect(out.warns[0]).toMatch(/sk-ant-oat01-/);
    expect(out.changed).toEqual([]);
  });

  it('removes the token of the picked account, offering only accounts that have one', async () => {
    const { ops, map, out } = setup();
    map.set('karst.sbx.token.claude.work', TOKEN);
    map.set('karst.sbx.token.claude.default', TOKEN);
    await ops.remove();
    expect(out.offered).toEqual([['work']]);
    expect(map.has('karst.sbx.token.claude.work')).toBe(false);
    expect(map.has('karst.sbx.token.claude.default')).toBe(true);
    expect(out.changed).toEqual(['work:removed']);
    expect(out.infos).toEqual(["The sbx token for the Claude account 'work' is removed."]);
  });

  it('tells the user when no account has a token and keeps quiet on cancel', async () => {
    const a = setup(); await a.ops.remove();
    expect(a.out.infos).toEqual(['No Claude account has an sbx token.']);
    const b = setup({ pick: undefined }); b.map.set('karst.sbx.token.claude.work', TOKEN); await b.ops.remove();
    expect(b.map.size).toBe(1);
    expect(b.out.infos).toEqual([]);
  });
});
