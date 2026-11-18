import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { request } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createKeyRegistry, createOauthProxy, OAUTH_BETA } from './proxyCore.js';

const KEY = 'k'.repeat(43);
const TOKEN = 'sk-ant-oat01-secret-token-value';
let upstream: Server; let proxy: Server;
let seen: { url?: string; method?: string; headers: IncomingHttpHeaders; body: string }[];
let logs: string[];
let registry: ReturnType<typeof createKeyRegistry>;

const listen = (s: Server) => new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as AddressInfo).port)));
let proxyPort = 0;

function call(opts: { path: string; method?: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; body: string; headers: IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: proxyPort, path: opts.path, method: opts.method ?? 'POST', headers: opts.headers }, (res) => {
      let body = ''; res.on('data', (c) => { body += c; }); res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on('error', reject); req.end(opts.body);
  });
}

beforeEach(async () => {
  seen = []; logs = []; registry = createKeyRegistry();
  upstream = createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ url: req.url, method: req.method, headers: req.headers, body });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: one\n\n');
      setTimeout(() => res.end('data: two\n\n'), 30);
    });
  });
  const upstreamPort = await listen(upstream);
  proxy = createOauthProxy({ registry, upstream: { protocol: 'http:', hostname: '127.0.0.1', port: upstreamPort }, log: (l) => logs.push(l) });
  proxyPort = await listen(proxy);
  expect(registry.register(KEY, TOKEN)).toBeNull();
});
afterEach(() => { upstream.close(); proxy.close(); upstream.closeAllConnections(); proxy.closeAllConnections(); });

describe('host oauth proxy', () => {
  it('replaces the credentials, adds the oauth beta and streams the reply', async () => {
    const res = await call({ path: '/v1/messages?beta=true', headers: { 'x-api-key': KEY, authorization: 'Bearer other', 'anthropic-beta': 'claude-code-20250219', host: 'evil.test', 'content-type': 'application/json' }, body: '{"a":1}' });
    expect(res.status).toBe(200);
    expect(res.body).toBe('data: one\n\ndata: two\n\n');
    const up = seen[0]!;
    expect(up.url).toBe('/v1/messages?beta=true');
    expect(up.body).toBe('{"a":1}');
    expect(up.headers['x-api-key']).toBeUndefined();
    expect(up.headers['authorization']).toBe(`Bearer ${TOKEN}`);
    expect(up.headers['anthropic-beta']).toBe(`claude-code-20250219,${OAUTH_BETA}`);
    expect(up.headers['host']).not.toBe('evil.test');
  });

  it('does not repeat the oauth beta and accepts the key as a bearer token', async () => {
    await call({ path: '/v1/messages', headers: { authorization: `Bearer ${KEY}`, 'anthropic-beta': OAUTH_BETA } });
    expect(seen[0]!.headers['anthropic-beta']).toBe(OAUTH_BETA);
  });

  it('answers 401 and does not forward an unknown or missing key', async () => {
    expect((await call({ path: '/v1/messages', headers: { 'x-api-key': 'u'.repeat(43) } })).status).toBe(401);
    expect((await call({ path: '/v1/messages' })).status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it('answers 401 after the key is revoked', async () => {
    registry.revoke(KEY);
    expect((await call({ path: '/v1/messages', headers: { 'x-api-key': KEY } })).status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it('refuses an absolute URI, a bad path and a traversal without forwarding', async () => {
    const h = { 'x-api-key': KEY };
    expect((await call({ path: 'http://api.anthropic.com/v1/messages', headers: h })).status).toBe(400);
    expect((await call({ path: '/api/oauth/profile', headers: h })).status).toBe(400);
    expect((await call({ path: '/v1/messages/../x', headers: h })).status).toBe(400);
    expect((await call({ path: '/v1/%2e%2e/x', headers: h })).status).toBe(400);
    expect(seen).toHaveLength(0);
  });

  it('refuses CONNECT', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: proxyPort, method: 'CONNECT', path: 'api.anthropic.com:443' });
      req.on('connect', (res, socket) => { socket.destroy(); resolve(res.statusCode ?? 0); });
      req.on('error', reject); req.end();
    });
    expect(status).toBe(405);
    expect(seen).toHaveLength(0);
  });

  it('answers 502 without detail when the upstream is down', async () => {
    upstream.close(); upstream.closeAllConnections();
    const res = await call({ path: '/v1/messages', headers: { 'x-api-key': KEY } });
    expect(res.status).toBe(502);
    expect(res.body).not.toContain('ECONNREFUSED');
  });

  it('logs no header, body, token or key', async () => {
    await call({ path: '/v1/messages?secret=q', headers: { 'x-api-key': KEY }, body: 'BODY-SECRET' });
    await call({ path: '/v1/messages', headers: { 'x-api-key': 'u'.repeat(43) } });
    const all = logs.join('\n');
    expect(all).toContain('POST /v1/messages 200');
    for (const s of [KEY, TOKEN, 'BODY-SECRET', 'secret=q', 'u'.repeat(43)]) expect(all).not.toContain(s);
  });
});

describe('key registry', () => {
  it('rejects a malformed key and a malformed token', () => {
    const r = createKeyRegistry();
    expect(r.register('short', TOKEN)).toMatch(/key/);
    expect(r.register(KEY, 'sk-ant-api03-xxxxxxxxxxxx')).toMatch(/token/);
    expect(r.size()).toBe(0);
  });
});
