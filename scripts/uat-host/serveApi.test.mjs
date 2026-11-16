import { describe, expect, it, vi } from 'vitest';
import { MAX_BODY_BYTES, allowedHost, allowedOrigin, routeRequest } from './serveApi.mjs';

const OK_SUMMARY = { total: 1, ran: 1, results: [{ index: 0, type: 'snapshot', status: 'pass' }] };
const NAME_ERR = 'name must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$';

function makeDeps(over = {}) {
  return {
    state: () => 'ready',
    fixture: () => 'ticket-mid-stage',
    hostPort: 4090,
    busy: () => false,
    evidenceExists: () => false,
    runProbe: vi.fn().mockResolvedValue({ ok: true, summary: OK_SUMMARY }),
    reset: vi.fn().mockResolvedValue({ ok: true, fixture: 'ticket-mid-stage' }),
    resolveFixtureFile: vi.fn((v) => `/work/${v}`),
    ...over,
  };
}
const HOST = { host: '127.0.0.1:4090' };
const JSON_HEADERS = { ...HOST, 'content-type': 'application/json' };
const req = (method, url, headers = HOST, body = '') => ({ method, url, headers, body });
const parse = (res) => JSON.parse(res.body);

describe('allowedHost / allowedOrigin', () => {
  it('accepts only the published host', () => {
    expect(allowedHost('127.0.0.1:4090', 4090)).toBe(true);
    expect(allowedHost('localhost:4090', 4090)).toBe(true);
    expect(allowedHost('127.0.0.1:9999', 4090)).toBe(false);
    expect(allowedHost('evil.example:4090', 4090)).toBe(false);
    expect(allowedHost(undefined, 4090)).toBe(false);
  });
  it.each([
    [undefined, true],
    ['http://127.0.0.1:4090', true],
    ['http://localhost:4090', true],
    ['https://evil.example', false],
    ['http://127.0.0.1:4091', false],
    ['null', false],
  ])('origin %s -> %s', (origin, want) => {
    expect(allowedOrigin(origin, 4090)).toBe(want);
  });
});

describe('GET /health', () => {
  it('is 200 with the instance token when ready', async () => {
    const res = await routeRequest(req('GET', '/health', {}), makeDeps({ instanceToken: 'tok' }));
    expect(res.status).toBe(200);
    expect(res.headers['x-karst-instance']).toBe('tok');
    expect(res.body).toBe('{"status":"ready"}');
  });
  it('is 503 without a token header when booting', async () => {
    const res = await routeRequest(req('GET', '/health', {}), makeDeps({ state: () => 'booting' }));
    expect(res.status).toBe(503);
    expect(res.headers['x-karst-instance']).toBeUndefined();
    expect(res.body).toBe('{"status":"booting"}');
  });
  it('has no Host or Origin check', async () => {
    const res = await routeRequest(req('GET', '/health', { host: 'evil.example:1234', origin: 'https://evil.example' }), makeDeps());
    expect(res.status).toBe(200);
  });
  it('refuses HEAD', async () => {
    expect((await routeRequest(req('HEAD', '/health', {}), makeDeps())).status).toBe(405);
  });
});

describe('GET /', () => {
  it('renders the FAKE CORE page', async () => {
    const res = await routeRequest(req('GET', '/'), makeDeps());
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.body).toContain('FAKE CORE');
    expect(res.body).toContain('/novnc/vnc.html?autoconnect=true&resize=scale&reconnect=true&path=websockify');
    expect(res.body).toContain('ticket-mid-stage');
  });
  it('escapes the fixture label', async () => {
    const res = await routeRequest(req('GET', '/'), makeDeps({ fixture: () => '<b>"x"&' }));
    expect(res.body).toContain('&lt;b&gt;&quot;x&quot;&amp;');
    expect(res.body).not.toContain('<b>"x"');
  });
  it('accepts localhost', async () => {
    expect((await routeRequest(req('GET', '/', { host: 'localhost:4090' }), makeDeps())).status).toBe(200);
  });
  it('refuses a foreign or missing host', async () => {
    const wrong = await routeRequest(req('GET', '/', { host: '127.0.0.1:9999' }), makeDeps());
    expect(wrong.status).toBe(403);
    expect(parse(wrong)).toEqual({ error: 'host not allowed' });
    expect((await routeRequest(req('GET', '/', {}), makeDeps())).status).toBe(403);
  });
  it('refuses a foreign origin', async () => {
    const res = await routeRequest(req('GET', '/', { ...HOST, origin: 'https://evil.example' }), makeDeps());
    expect(res.status).toBe(403);
    expect(parse(res)).toEqual({ error: 'origin not allowed' });
  });
});

describe('POST /probe', () => {
  const body = '{"steps":[{"type":"snapshot"}]}';
  it('refuses a foreign origin', async () => {
    const res = await routeRequest(req('POST', '/probe?name=a1', { ...JSON_HEADERS, origin: 'https://evil.example' }, body), makeDeps());
    expect(res.status).toBe(403);
    expect(parse(res)).toEqual({ error: 'origin not allowed' });
  });
  it('refuses a foreign host', async () => {
    const res = await routeRequest(req('POST', '/probe?name=a1', { ...JSON_HEADERS, host: 'evil:1' }, body), makeDeps());
    expect(res.status).toBe(403);
  });
  it('refuses a content type that is not JSON', async () => {
    const res = await routeRequest(req('POST', '/probe?name=a1', { ...HOST, 'content-type': 'text/plain' }, body), makeDeps());
    expect(res.status).toBe(415);
  });
  it('accepts a JSON content type with a charset', async () => {
    const res = await routeRequest(req('POST', '/probe?name=a1', { ...HOST, 'content-type': 'application/json; charset=utf-8' }, body), makeDeps());
    expect(res.status).toBe(200);
  });
  it.each([['/probe?name=../x'], ['/probe'], ['/probe?name='], [`/probe?name=${'a'.repeat(65)}`]])('refuses the name in %s', async (url) => {
    const res = await routeRequest(req('POST', url, JSON_HEADERS, body), makeDeps());
    expect(res.status).toBe(400);
    expect(parse(res)).toEqual({ error: NAME_ERR });
  });
  it.each([['{"nosteps":1}'], ['not json'], ['"x"'], ['null']])('refuses the body %s', async (text) => {
    const res = await routeRequest(req('POST', '/probe?name=a1', JSON_HEADERS, text), makeDeps());
    expect(res.status).toBe(400);
    expect(parse(res)).toEqual({ error: 'body must be a step list: an array or {"steps": [...]}' });
  });
  it('is 503 when the host is not ready', async () => {
    const res = await routeRequest(req('POST', '/probe?name=a1', JSON_HEADERS, body), makeDeps({ state: () => 'booting' }));
    expect(res.status).toBe(503);
    expect(parse(res)).toEqual({ error: 'not ready', status: 'booting' });
  });
  it('is 409 when busy', async () => {
    const res = await routeRequest(req('POST', '/probe?name=a1', JSON_HEADERS, body), makeDeps({ busy: () => true }));
    expect(res.status).toBe(409);
    expect(parse(res)).toEqual({ error: 'busy' });
  });
  it('is 409 when the evidence name exists', async () => {
    const evidenceExists = vi.fn(() => true);
    const res = await routeRequest(req('POST', '/probe?name=a1', JSON_HEADERS, body), makeDeps({ evidenceExists }));
    expect(res.status).toBe(409);
    expect(parse(res)).toEqual({ error: 'evidence name already used: a1' });
    expect(evidenceExists).toHaveBeenCalledWith('a1');
  });
  it('runs the probe and returns the summary', async () => {
    const deps = makeDeps();
    const res = await routeRequest(req('POST', '/probe?name=a1', JSON_HEADERS, body), deps);
    expect(res.status).toBe(200);
    expect(res.body).toBe(JSON.stringify({ name: 'a1', evidence: '.karst/uat-scratch/out/a1', pass: true, summary: OK_SUMMARY }));
    expect(deps.runProbe).toHaveBeenCalledWith('a1', JSON.parse(body));
  });
  it('reports pass false for a failed step', async () => {
    const summary = { total: 1, ran: 1, results: [{ index: 0, type: 'snapshot', status: 'fail' }] };
    const res = await routeRequest(req('POST', '/probe?name=a1', JSON_HEADERS, body), makeDeps({ runProbe: vi.fn().mockResolvedValue({ ok: true, summary }) }));
    expect(res.status).toBe(200);
    expect(parse(res).pass).toBe(false);
  });
  it('is 422 when the host refuses the script', async () => {
    const res = await routeRequest(req('POST', '/probe?name=a1', JSON_HEADERS, body), makeDeps({ runProbe: vi.fn().mockResolvedValue({ ok: false, error: 'step 0: x' }) }));
    expect(res.status).toBe(422);
    expect(parse(res)).toEqual({ error: 'step 0: x' });
  });
  it('is 504 on a timeout', async () => {
    const res = await routeRequest(req('POST', '/probe?name=a1', JSON_HEADERS, body), makeDeps({ runProbe: vi.fn().mockResolvedValue({ timedOut: true }) }));
    expect(res.status).toBe(504);
    expect(parse(res)).toEqual({ error: 'probe timed out; the host is being reset' });
  });
  it('is 413 over the body limit', async () => {
    const big = 'x'.repeat(MAX_BODY_BYTES + 1);
    const res = await routeRequest(req('POST', '/probe?name=a1', JSON_HEADERS, big), makeDeps());
    expect(res.status).toBe(413);
    expect(parse(res)).toEqual({ error: 'body over 1048576 bytes' });
  });
  it('counts bytes, not characters', async () => {
    const big = 'é'.repeat(MAX_BODY_BYTES / 2 + 1);
    expect((await routeRequest(req('POST', '/probe?name=a1', JSON_HEADERS, big), makeDeps())).status).toBe(413);
  });
  it('accepts a bare array of steps', async () => {
    const deps = makeDeps();
    const res = await routeRequest(req('POST', '/probe?name=a1', JSON_HEADERS, '[{"type":"snapshot"}]'), deps);
    expect(res.status).toBe(200);
    expect(deps.runProbe).toHaveBeenCalledWith('a1', [{ type: 'snapshot' }]);
  });
});

describe('POST /reset', () => {
  const post = (body, deps = makeDeps(), headers = JSON_HEADERS) => routeRequest(req('POST', '/reset', headers, body), deps);
  it('resets to the current fixture for {}', async () => {
    const deps = makeDeps();
    const res = await post('{}', deps);
    expect(res.status).toBe(200);
    expect(res.body).toBe('{"status":"ready","fixture":"ticket-mid-stage"}');
    expect(deps.reset).toHaveBeenCalledWith({});
  });
  it('treats an empty body as {}', async () => {
    const deps = makeDeps();
    await post('', deps);
    expect(deps.reset).toHaveBeenCalledWith({});
  });
  it('passes a named fixture', async () => {
    const deps = makeDeps();
    await post('{"fixture":"blocked"}', deps);
    expect(deps.reset).toHaveBeenCalledWith({ fixture: 'blocked' });
  });
  it('refuses an unknown fixture', async () => {
    const res = await post('{"fixture":"nope"}');
    expect(res.status).toBe(400);
    expect(parse(res)).toEqual({ error: 'fixture must be one of empty, ticket-mid-stage, blocked, launch-draft' });
  });
  it('resolves a fixture file', async () => {
    const deps = makeDeps();
    await post('{"fixtureFile":"x.json"}', deps);
    expect(deps.resolveFixtureFile).toHaveBeenCalledWith('x.json');
    expect(deps.reset).toHaveBeenCalledWith({ fixtureFile: '/work/x.json' });
  });
  it('is 400 when the fixture file is outside', async () => {
    const deps = makeDeps({ resolveFixtureFile: vi.fn(() => { throw new Error('outside'); }) });
    const res = await post('{"fixtureFile":"x.json"}', deps);
    expect(res.status).toBe(400);
    expect(parse(res)).toEqual({ error: 'outside' });
    expect(deps.reset).not.toHaveBeenCalled();
  });
  it.each([['{"fixture":"empty","fixtureFile":"x.json"}'], ['{"other":1}']])('refuses %s', async (text) => {
    const res = await post(text);
    expect(res.status).toBe(400);
    expect(parse(res)).toEqual({ error: 'reset body takes at most one of fixture, fixtureFile' });
  });
  it('refuses a body that is not a JSON object', async () => {
    expect((await post('nope')).status).toBe(400);
    expect((await post('[]')).status).toBe(400);
  });
  it('is 409 when busy', async () => {
    const deps = makeDeps({ busy: () => true });
    expect((await post('{}', deps)).status).toBe(409);
    expect(deps.reset).not.toHaveBeenCalled();
  });
  it('is 500 when the boot failed', async () => {
    const res = await post('{}', makeDeps({ reset: vi.fn().mockResolvedValue({ ok: false, error: 'boot failed' }) }));
    expect(res.status).toBe(500);
    expect(parse(res)).toEqual({ error: 'boot failed' });
  });
  it('refuses a foreign origin', async () => {
    const res = await post('{}', makeDeps(), { ...JSON_HEADERS, origin: 'https://evil.example' });
    expect(res.status).toBe(403);
  });
  it('refuses a non-JSON content type and a big body', async () => {
    expect((await post('{}', makeDeps(), { ...HOST, 'content-type': 'text/plain' })).status).toBe(415);
    expect((await post(' '.repeat(MAX_BODY_BYTES + 1))).status).toBe(413);
  });
});

describe('other routes', () => {
  it('is 405 for a wrong method on a known path', async () => {
    expect((await routeRequest(req('GET', '/probe'), makeDeps())).status).toBe(405);
    expect((await routeRequest(req('GET', '/reset'), makeDeps())).status).toBe(405);
    expect((await routeRequest(req('POST', '/'), makeDeps())).status).toBe(405);
  });
  it('is 404 for an unknown path', async () => {
    const res = await routeRequest(req('GET', '/nope'), makeDeps());
    expect(res.status).toBe(404);
    expect(parse(res)).toEqual({ error: 'not found' });
  });
});
