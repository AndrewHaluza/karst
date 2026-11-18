import { describe, expect, it, vi } from 'vitest';
import type { SecretStore } from './secretStore.js';
import { createSbxGrantStore } from './sbxGrantStore.js';
import { setSbxToken } from './sbxTokenStore.js';

const TOKEN = 'sk-ant-oat01-abcdefghijklmnopqrstuvwxyz';
const memory = (): SecretStore & { map: Map<string, string> } => {
  const map = new Map<string, string>();
  return { map, get: async (k) => map.get(k), store: async (k, v) => { map.set(k, v); }, delete: async (k) => { map.delete(k); } };
};

async function setup(over: { port?: number | undefined; ensure?: () => Promise<void>; register?: (k: string, t: string) => Promise<void>; revoke?: (k: string) => Promise<void> } = {}) {
  const secrets = memory();
  await setSbxToken(secrets, 'claude', 'work', TOKEN);
  const client = { register: vi.fn(over.register ?? (async () => undefined)), revoke: vi.fn(over.revoke ?? (async () => undefined)), readPort: vi.fn(async () => ('port' in over ? over.port : 8787)) };
  const debug = vi.fn();
  const store = createSbxGrantStore({ secrets, client, ensureProxy: over.ensure ?? (async () => undefined), debug });
  return { secrets, client, debug, store };
}

describe('sbx grant store', () => {
  it('issues a fresh key, registers it with the account token and gives the proxy port', async () => {
    const { store, client } = await setup();
    const out = await store.issue('sb', 'work');
    expect(out).toMatchObject({ ok: true, port: 8787 });
    if (!out.ok) throw new Error('unreachable');
    expect(out.key.length).toBeGreaterThanOrEqual(43);
    expect(client.register).toHaveBeenCalledWith(out.key, TOKEN);
    expect(out.replacedPort).toBeUndefined();
  });

  it('revokes the key of the previous launch and names its port', async () => {
    const { store, client } = await setup();
    const a = await store.issue('sb', 'work');
    const b = await store.issue('sb', 'work');
    if (!a.ok || !b.ok) throw new Error('unreachable');
    expect(b.key).not.toBe(a.key);
    expect(client.revoke).toHaveBeenCalledWith(a.key);
    expect(b.replacedPort).toBe(8787);
  });

  it('fails with a reason, and no key, when the account has no token', async () => {
    const { store, client } = await setup();
    const out = await store.issue('sb', 'other');
    expect(out).toEqual({ ok: false, reason: "the Claude account 'other' has no sbx token" });
    expect(client.register).not.toHaveBeenCalled();
  });

  it('fails when the proxy does not start, has no port or refuses the key, without a secret in the reason', async () => {
    const down = await (await setup({ ensure: async () => { throw new Error('boom ' + TOKEN); } })).store.issue('sb', 'work');
    expect(down).toMatchObject({ ok: false, reason: expect.stringContaining('OAuth proxy') });
    const noPort = await (await setup({ port: undefined })).store.issue('sb', 'work');
    expect(noPort).toMatchObject({ ok: false, reason: expect.stringContaining('port') });
    const refused = await (await setup({ register: async () => { throw new Error('refused ' + TOKEN); } })).store.issue('sb', 'work');
    expect(refused.ok).toBe(false);
    expect(JSON.stringify(down) + JSON.stringify(refused)).not.toContain(TOKEN);
  });

  it('release revokes the key, forgets it and returns the port', async () => {
    const { store, client, secrets } = await setup();
    const a = await store.issue('sb', 'work');
    if (!a.ok) throw new Error('unreachable');
    expect(await store.release('sb')).toEqual({ port: 8787 });
    expect(client.revoke).toHaveBeenCalledWith(a.key);
    expect([...secrets.map.keys()].filter((k) => k.includes('grant') && k !== 'karst.sbx.grants.index')).toEqual([]);
    expect(await store.release('sb')).toEqual({});
    expect(await store.liveRegistrations()).toEqual([]);
  });

  it('release still forgets the key when the proxy is down, and logs it', async () => {
    const { store, debug } = await setup({ revoke: async () => { throw new Error('down'); } });
    await store.issue('sb', 'work');
    expect(await store.release('sb')).toEqual({ port: 8787 });
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('revoke failed'));
  });

  it('lists the live keys with their account tokens for a proxy restart', async () => {
    const { store } = await setup();
    const a = await store.issue('sb1', 'work');
    await store.issue('sb2', 'work');
    if (!a.ok) throw new Error('unreachable');
    const live = await store.liveRegistrations();
    expect(live).toHaveLength(2);
    expect(live).toContainEqual({ key: a.key, token: TOKEN });
  });

  it('revokeAccount kills the keys of the account, keeps the port for the later release, and drops them from the live list', async () => {
    const { store, client } = await setup();
    const a = await store.issue('sb', 'work');
    if (!a.ok) throw new Error('unreachable');
    await store.revokeAccount('work');
    expect(client.revoke).toHaveBeenCalledWith(a.key);
    expect(await store.liveRegistrations()).toEqual([]);
    expect(await store.release('sb')).toEqual({ port: 8787 });
  });

  it('keeps no token in the stored grant', async () => {
    const { store, secrets } = await setup();
    await store.issue('sb', 'work');
    const grant = [...secrets.map.entries()].find(([k]) => k.startsWith('karst.sbx.grant.'))!;
    expect(grant[1]).not.toContain(TOKEN);
  });
});
