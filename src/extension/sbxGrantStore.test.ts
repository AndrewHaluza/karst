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

  it('release keeps the record when the revoke fails, logs it, and a later release retries the revoke', async () => {
    let down = true;
    const { store, debug, client, secrets } = await setup({ revoke: async () => { if (down) throw new Error('down'); } });
    const a = await store.issue('sb', 'work');
    if (!a.ok) throw new Error('unreachable');
    expect(await store.release('sb')).toEqual({ port: 8787 });
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('revoke failed'));
    expect(secrets.map.has('karst.sbx.grant.sb')).toBe(true);
    down = false;
    expect(await store.release('sb')).toEqual({ port: 8787 });
    expect(client.revoke).toHaveBeenLastCalledWith(a.key);
    expect(secrets.map.has('karst.sbx.grant.sb')).toBe(false);
    expect(JSON.parse(secrets.map.get('karst.sbx.grants.index') ?? '[]')).toEqual([]);
  });

  it('keeps every sandbox in the index when launches and releases overlap', async () => {
    const { store, secrets } = await setup();
    await Promise.all(['s1', 's2', 's3', 's4'].map((n) => store.issue(n, 'work')));
    expect(JSON.parse(secrets.map.get('karst.sbx.grants.index') ?? '[]').sort()).toEqual(['s1', 's2', 's3', 's4']);
    await Promise.all([store.release('s1'), store.release('s2'), store.issue('s5', 'work')]);
    expect(JSON.parse(secrets.map.get('karst.sbx.grants.index') ?? '[]').sort()).toEqual(['s3', 's4', 's5']);
  });

  it('revokeAccount does not mark a key revoked when the proxy refuses, and a later call retries it', async () => {
    let down = true;
    const { store, secrets, client } = await setup({ revoke: async () => { if (down) throw new Error('down'); } });
    const a = await store.issue('sb', 'work');
    if (!a.ok) throw new Error('unreachable');
    await store.revokeAccount('work');
    expect(JSON.parse(secrets.map.get('karst.sbx.grant.sb')!).revoked).not.toBe(true);
    down = false;
    await store.revokeAccount('work');
    expect(client.revoke).toHaveBeenLastCalledWith(a.key);
    expect(JSON.parse(secrets.map.get('karst.sbx.grant.sb')!).revoked).toBe(true);
  });

  it('issue keeps the old key for a retry when its revoke fails, and the release revokes both keys', async () => {
    let down = true;
    const { store, client } = await setup({ revoke: async () => { if (down) throw new Error('down'); } });
    const a = await store.issue('sb', 'work');
    const b = await store.issue('sb', 'work');
    if (!a.ok || !b.ok) throw new Error('unreachable');
    down = false;
    client.revoke.mockClear();
    expect(await store.release('sb')).toEqual({ port: 8787 });
    expect(client.revoke.mock.calls.map((c) => c[0]).sort()).toEqual([a.key, b.key].sort());
  });

  it('issue revokes the new key and refuses the launch when the grant record cannot be saved', async () => {
    const { store, secrets, client } = await setup();
    const store0 = secrets.store.bind(secrets);
    secrets.store = async (k: string, v: string) => { if (k.startsWith('karst.sbx.grant.')) throw new Error('keychain sk-ant-secret'); return store0(k, v); };
    const out = await store.issue('sb', 'work');
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.reason).not.toContain('secret');
    const registered = client.register.mock.calls[0]![0];
    expect(client.revoke).toHaveBeenCalledWith(registered);
  });

  it('does not register again, at a proxy start, the key of a removed sandbox whose revoke failed', async () => {
    const { store } = await setup({ revoke: async () => { throw new Error('down'); } });
    await store.issue('sb', 'work');
    await store.release('sb');
    expect(await store.liveRegistrations()).toEqual([]);
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
  it('gives an exact reason for each failed issue', async () => {
    expect(await (await setup({ ensure: async () => { throw new Error('x'); } })).store.issue('sb', 'work')).toEqual({ ok: false, reason: 'the OAuth proxy did not start' });
    expect(await (await setup({ port: undefined })).store.issue('sb', 'work')).toEqual({ ok: false, reason: 'the OAuth proxy port is unknown' });
    expect(await (await setup({ register: async () => { throw new Error('x'); } })).store.issue('sb', 'work')).toEqual({ ok: false, reason: 'the OAuth proxy refused the sandbox key' });
  });

  it('logs a failure with the step and the sandbox, and no detail of the error', async () => {
    const a = await setup({ ensure: async () => { throw new Error('secret ' + TOKEN); } });
    await a.store.issue('sb', 'work');
    expect(a.debug).toHaveBeenCalledWith('[oauth-proxy] start failed for sb: error');
    const b = await setup({ register: async () => { throw 'plain'; } });
    await b.store.issue('sb', 'work');
    expect(b.debug).toHaveBeenCalledWith('[oauth-proxy] register failed for sb: unknown error');
  });

  it('works with no debug callback', async () => {
    const secrets = memory();
    await setSbxToken(secrets, 'claude', 'work', TOKEN);
    const store = createSbxGrantStore({ secrets, client: { register: async () => undefined, revoke: async () => { throw new Error('x'); }, readPort: async () => 1 }, ensureProxy: async () => { throw new Error('y'); } });
    expect(await store.issue('sb', 'work')).toMatchObject({ ok: false });
    await expect(store.release('sb')).resolves.toEqual({});
  });

  it('lists a sandbox once in the index, however often it launches, and keeps the others on release', async () => {
    const { store, secrets } = await setup();
    await store.issue('sb1', 'work');
    await store.issue('sb1', 'work');
    await store.issue('sb2', 'work');
    expect(JSON.parse(secrets.map.get('karst.sbx.grants.index')!)).toEqual(['sb1', 'sb2']);
    await store.release('sb1');
    expect(JSON.parse(secrets.map.get('karst.sbx.grants.index')!)).toEqual(['sb2']);
    expect(await store.liveRegistrations()).toHaveLength(1);
  });

  it('reads no grant from a damaged record or index', async () => {
    const { store, secrets } = await setup();
    const bad = [null, 1, {}, { key: 'k', account: 'work' }, { key: 'k', account: 'work', port: '1' }, { key: 1, account: 'work', port: 1 }, { key: 'k', account: 2, port: 1 }];
    for (const [i, g] of bad.entries()) secrets.map.set(`karst.sbx.grant.bad${i}`, JSON.stringify(g));
    secrets.map.set('karst.sbx.grant.junk', 'not json');
    secrets.map.set('karst.sbx.grants.index', JSON.stringify([...bad.keys()].map((i) => `bad${i}`).concat(['junk', 5 as unknown as string])));
    expect(await store.liveRegistrations()).toEqual([]);
    for (const n of ['bad0', 'bad3', 'bad4', 'bad5', 'bad6', 'junk']) expect(await store.release(n)).toEqual({});
    secrets.map.set('karst.sbx.grants.index', '{"a":1}');
    expect(await store.liveRegistrations()).toEqual([]);
    secrets.map.set('karst.sbx.grants.index', 'not json');
    expect(await store.liveRegistrations()).toEqual([]);
    expect(await store.issue('sb', 'work')).toMatchObject({ ok: true });
  });

  it('revokeAccount leaves other accounts alone and revokes a key once', async () => {
    const { store, client, secrets } = await setup();
    await setSbxToken(secrets, 'claude', 'other', TOKEN);
    const a = await store.issue('sb1', 'work');
    const b = await store.issue('sb2', 'other');
    if (!a.ok || !b.ok) throw new Error('unreachable');
    await store.revokeAccount('work');
    await store.revokeAccount('work');
    expect(client.revoke).toHaveBeenCalledTimes(1);
    expect(client.revoke).toHaveBeenCalledWith(a.key);
    expect(JSON.parse(secrets.map.get('karst.sbx.grant.sb1')!)).toMatchObject({ revoked: true, account: 'work' });
    expect(JSON.parse(secrets.map.get('karst.sbx.grant.sb2')!).revoked).toBeUndefined();
    expect(await store.liveRegistrations()).toEqual([{ key: b.key, token: TOKEN }]);
    await store.release('sb1');
    expect(client.revoke).toHaveBeenCalledTimes(1);
  });

  it('a live key whose account lost its token is not listed', async () => {
    const { store, secrets } = await setup();
    await store.issue('sb', 'work');
    secrets.map.delete('karst.sbx.token.claude.work');
    expect(await store.liveRegistrations()).toEqual([]);
  });
  it('keeps both sandbox names when two windows (two stores on one secret storage) launch at the same time', async () => {
    const map = new Map<string, string>();
    const sleep = (): Promise<void> => new Promise((r) => setTimeout(r, 5));
    // A slow shared storage: every read and write yields, so an unguarded read-change-write loses an update.
    const secrets: SecretStore = { get: async (k) => { await sleep(); return map.get(k); }, store: async (k, v) => { await sleep(); map.set(k, v); }, delete: async (k) => { map.delete(k); } };
    await setSbxToken(secrets, 'claude', 'work', TOKEN);
    const client = { register: vi.fn(async () => undefined), revoke: vi.fn(async () => undefined), readPort: vi.fn(async () => 8787) };
    let held = false;
    let queue: Promise<unknown> = Promise.resolve();
    // One lock for both windows (the production lock is a directory shared by the windows).
    const lock = <T,>(section: () => Promise<T>): Promise<T> => { const run = queue.then(async () => { if (held) throw new Error('overlap'); held = true; try { return await section(); } finally { held = false; } }); queue = run.catch(() => undefined); return run; };
    const win = (): ReturnType<typeof createSbxGrantStore> => createSbxGrantStore({ secrets, client, ensureProxy: async () => undefined, lock });
    const [a, b] = [win(), win()];
    await Promise.all([a.issue('sb-a', 'work'), b.issue('sb-b', 'work')]);
    expect(JSON.parse(map.get('karst.sbx.grants.index') ?? '[]').sort()).toEqual(['sb-a', 'sb-b']);
    expect((await a.liveRegistrations()).length).toBe(2);
  });

  it('fails the launch, and revokes its key, when the index lock cannot be taken', async () => {
    const secrets = memory();
    await setSbxToken(secrets, 'claude', 'work', TOKEN);
    const client = { register: vi.fn(async () => undefined), revoke: vi.fn(async () => undefined), readPort: vi.fn(async () => 8787) };
    const store = createSbxGrantStore({ secrets, client, ensureProxy: async () => undefined, lock: async () => { throw new Error('held'); } });
    const out = await store.issue('sb', 'work');
    expect(out).toEqual({ ok: false, reason: 'the sandbox key could not be stored' });
    expect(client.revoke).toHaveBeenCalled();
  });
});
