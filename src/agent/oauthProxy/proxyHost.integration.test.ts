import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProxyClient, newSandboxKey, proxyPaths } from './client.js';
import { createProxyLifecycle } from './lifecycle.js';
import { startProxyHost, type RunningProxy } from './proxyHost.js';

const TOKEN = 'sk-ant-oat01-secret-token-value';
let root: string; let upstream: Server; let upstreamPort: number; let running: RunningProxy | undefined;
let authSeen: (string | undefined)[];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'oauth-proxy-'));
  authSeen = [];
  upstream = createServer((req, res) => { authSeen.push(req.headers['authorization']); res.end('ok'); });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
  upstreamPort = (upstream.address() as AddressInfo).port;
});
afterEach(async () => { await running?.close(); running = undefined; upstream.close(); upstream.closeAllConnections(); await rm(root, { recursive: true, force: true }); });

const start = (paths: ReturnType<typeof proxyPaths>) =>
  startProxyHost({ portFile: paths.portFile, controlDir: paths.controlDir, upstream: { protocol: 'http:', hostname: '127.0.0.1', port: upstreamPort } });

function viaProxy(port: number, key: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/v1/messages', method: 'POST', headers: { 'x-api-key': key } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)); });
    req.on('error', reject); req.end();
  });
}

describe('proxy host', () => {
  it('writes a 0600 port file, a 0700 control dir and a 0600 socket, bound to loopback', async () => {
    const paths = proxyPaths(root);
    running = await start(paths);
    expect(await readFile(paths.portFile, 'utf8')).toBe(`${running!.port}\n`);
    expect((await stat(paths.portFile)).mode & 0o777).toBe(0o600);
    expect((await stat(paths.controlDir)).mode & 0o777).toBe(0o700);
    expect((await stat(paths.socketPath)).mode & 0o777).toBe(0o600);
    const client = createProxyClient(paths);
    expect(await client.readPort()).toBe(running!.port);
    expect(await client.health()).toEqual({ ok: true, port: running!.port, keys: 0 });
  });

  it('registers and revokes a key over the control socket', async () => {
    const paths = proxyPaths(root);
    running = await start(paths);
    const client = createProxyClient(paths);
    const key = newSandboxKey();
    expect(key).toHaveLength(43);
    expect(await viaProxy(running!.port, key)).toBe(401);
    await client.register(key, TOKEN);
    expect(await viaProxy(running!.port, key)).toBe(200);
    expect(authSeen).toEqual([`Bearer ${TOKEN}`]);
    await client.revoke(key);
    expect(await viaProxy(running!.port, key)).toBe(401);
  });

  it('refuses a bad registration', async () => {
    const paths = proxyPaths(root);
    running = await start(paths);
    await expect(createProxyClient(paths).register('short', TOKEN)).rejects.toThrow(/refused/);
  });

  it('does not start a second proxy for the same editor', async () => {
    const paths = proxyPaths(root);
    running = await start(paths);
    expect(await start(paths)).toBeUndefined();
  });

  it('reuses the last port after a restart and the lifecycle re-registers the live sandboxes', async () => {
    const paths = proxyPaths(root);
    const client = createProxyClient(paths);
    const key = newSandboxKey();
    let spawns = 0;
    const lifecycle = createProxyLifecycle({
      client, liveRegistrations: async () => [{ key, token: TOKEN }],
      spawnProxy: () => { spawns += 1; void start(paths).then((r) => { running = r; }); },
    });
    await lifecycle.sync();
    expect(spawns).toBe(1);
    const firstPort = running!.port;
    expect(await viaProxy(firstPort, key)).toBe(200);

    await running!.close(); running = undefined; // crash: the keys are gone
    expect(await lifecycle.probe()).toBe(true);
    expect(spawns).toBe(2);
    expect(running!.port).toBe(firstPort);
    expect(await viaProxy(running!.port, key)).toBe(200);
    expect(await lifecycle.probe()).toBe(false);
  });
});
