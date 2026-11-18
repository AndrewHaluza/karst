import { describe, expect, it } from 'vitest';
import { newSandboxKey, proxyPaths, type ProxyClient } from './client.js';
import { createProxyLifecycle } from './lifecycle.js';

function fakeClient(healthy: () => boolean) {
  const registered: [string, string][] = [];
  const client: ProxyClient = {
    health: async () => (healthy() ? { ok: true, port: 1, keys: 0 } : undefined),
    register: async (k, t) => { registered.push([k, t]); },
    revoke: async () => {},
    readPort: async () => 1,
  };
  return { client, registered };
}
const wait = async () => {};

describe('proxy lifecycle', () => {
  it('registers live sandboxes without a spawn when the proxy is healthy', async () => {
    const { client, registered } = fakeClient(() => true);
    let spawns = 0;
    const l = createProxyLifecycle({ client, spawnProxy: () => { spawns += 1; }, liveRegistrations: async () => [{ key: 'a', token: 't' }], wait });
    await l.sync();
    expect(spawns).toBe(0);
    expect(registered).toEqual([['a', 't']]);
  });

  it('spawns when the proxy is missing and registers once it is healthy', async () => {
    let up = false;
    const { client, registered } = fakeClient(() => up);
    const l = createProxyLifecycle({ client, spawnProxy: () => { up = true; }, liveRegistrations: async () => [{ key: 'a', token: 't' }], wait });
    await l.sync();
    expect(registered).toEqual([['a', 't']]);
  });

  it('fails when the proxy never becomes healthy', async () => {
    const { client, registered } = fakeClient(() => false);
    const l = createProxyLifecycle({ client, spawnProxy: () => {}, liveRegistrations: async () => [], wait, startTimeoutMs: 300 });
    await expect(l.sync()).rejects.toThrow(/did not start/);
    expect(registered).toEqual([]);
  });

  it('shares one run between concurrent syncs', async () => {
    let spawns = 0; let up = false;
    const { client } = fakeClient(() => up);
    const l = createProxyLifecycle({ client, spawnProxy: () => { spawns += 1; up = true; }, liveRegistrations: async () => [], wait });
    await Promise.all([l.sync(), l.sync()]);
    expect(spawns).toBe(1);
  });

  it('probe re-registers when healthy and fully re-syncs after a failed health check', async () => {
    let up = true;
    const { client, registered } = fakeClient(() => up);
    const l = createProxyLifecycle({ client, spawnProxy: () => { up = true; }, liveRegistrations: async () => [{ key: 'a', token: 't' }], wait });
    expect(await l.probe()).toBe(false);
    expect(registered).toEqual([['a', 't']]); // healthy: still re-registers, a peer window may have restarted the proxy
    registered.length = 0;
    up = false;
    expect(await l.probe()).toBe(true);
    expect(registered).toEqual([['a', 't']]);
  });
});

describe('proxy paths and keys', () => {
  it('differs per editor and keeps the socket path short', () => {
    const a = proxyPaths('/Users/x/Library/Application Support/Code/User/globalStorage/karst.karst', '/tmp');
    const b = proxyPaths('/Users/x/Library/Application Support/Cursor/User/globalStorage/karst.karst', '/tmp');
    expect(a.controlDir).not.toBe(b.controlDir);
    expect(a.socketPath.length).toBeLessThan(60);
    expect(a.portFile).toBe('/Users/x/Library/Application Support/Code/User/globalStorage/karst.karst/oauth-proxy.port');
  });
  it('makes distinct 256-bit keys', () => {
    expect(newSandboxKey()).not.toBe(newSandboxKey());
    expect(newSandboxKey()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
