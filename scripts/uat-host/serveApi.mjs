// Pure HTTP routing for the serve supervisor (arch:UATHOST-08). No I/O: serveServer.mjs injects every side effect.
export const SERVE_CONTAINER_PORT = 8080;
export const MAX_BODY_BYTES = 1048576;
export const SERVE_FIXTURES = ['empty', 'ticket-mid-stage', 'blocked', 'launch-draft'];
export const EVIDENCE_REL = '.karst/uat-scratch/out';
export const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const NAME_ERROR = 'name must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$';
const STEPS_ERROR = 'body must be a step list: an array or {"steps": [...]}';
const RESET_BODY_ERROR = 'reset body takes at most one of fixture, fixtureFile';
const VIEW_SRC = '/novnc/vnc.html?autoconnect=true&resize=scale&reconnect=true&path=websockify';

/** DNS rebinding guard: only the published loopback names pass. */
export function allowedHost(hostHeader, hostPort) {
  return hostHeader === `127.0.0.1:${hostPort}` || hostHeader === `localhost:${hostPort}`;
}

/** A browser sends a WebSocket upgrade from any site without a CORS check, so the Origin must be absent or loopback. */
export function allowedOrigin(originHeader, hostPort) {
  return originHeader === undefined || originHeader === `http://127.0.0.1:${hostPort}` || originHeader === `http://localhost:${hostPort}`;
}

/** The parsed step list (an array, or an object whose `steps` is an array). Throws the 400 message otherwise. */
export function parseStepScript(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(STEPS_ERROR);
  }
  if (Array.isArray(value) || (value !== null && typeof value === 'object' && Array.isArray(value.steps))) return value;
  throw new Error(STEPS_ERROR);
}

/** `{}`, `{ fixture }` or `{ fixtureFile }` (resolved). Throws the 400 message otherwise. */
export function parseResetBody(text, resolveFixtureFile) {
  if (text.trim() === '') return {};
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('body must be a JSON object');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('body must be a JSON object');
  const keys = Object.keys(value);
  if (keys.length === 0) return {};
  if (keys.length > 1 || (keys[0] !== 'fixture' && keys[0] !== 'fixtureFile')) throw new Error(RESET_BODY_ERROR);
  if (keys[0] === 'fixture') {
    if (!SERVE_FIXTURES.includes(value.fixture)) throw new Error(`fixture must be one of ${SERVE_FIXTURES.join(', ')}`);
    return { fixture: value.fixture };
  }
  if (typeof value.fixtureFile !== 'string' || value.fixtureFile === '') throw new Error('fixtureFile must be a path string');
  return { fixtureFile: resolveFixtureFile(value.fixtureFile) };
}

const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The `/` page: the FAKE CORE banner above the noVNC client. The banner is page HTML, so the view never shows without it. */
export function renderViewPage({ state, fixture }) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Karst UAT host (FAKE CORE)</title></head>
<body style="margin:0">
<div id="fake-core-banner" style="position:sticky;top:0;background:#b00020;color:#fff;font:600 16px system-ui;padding:8px 16px">FAKE CORE — simulated VS Code (KARST_FAKE_CORE=1). No LLM is called. Fixture: ${escapeHtml(fixture)} · State: ${escapeHtml(state)}</div>
<iframe src="${VIEW_SRC}" style="border:0;width:100%;height:calc(100vh - 40px)"></iframe>
</body></html>
`;
}

const json = (status, obj, headers = {}) => ({ status, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(obj) });
const fail = (status, error, extra = {}) => json(status, { error, ...extra });

function health(deps) {
  const state = deps.state();
  const headers = deps.instanceToken ? { 'x-karst-instance': deps.instanceToken } : {};
  return json(state === 'ready' ? 200 : 503, { status: state }, headers);
}

/** 415 / 413 gate shared by the two POST routes. Null when the request passes. */
function bodyGate(req) {
  if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return fail(415, 'content type must be application/json');
  if (Buffer.byteLength(req.body) > MAX_BODY_BYTES) return fail(413, `body over ${MAX_BODY_BYTES} bytes`);
  return null;
}

async function probe(req, query, deps) {
  const gate = bodyGate(req);
  if (gate) return gate;
  const name = query.get('name') ?? '';
  if (!NAME_PATTERN.test(name)) return fail(400, NAME_ERROR);
  let script;
  try {
    script = parseStepScript(req.body);
  } catch (err) {
    return fail(400, err.message);
  }
  const state = deps.state();
  if (state !== 'ready') return fail(503, 'not ready', { status: state });
  if (deps.busy()) return fail(409, 'busy');
  if (deps.evidenceExists(name)) return fail(409, `evidence name already used: ${name}`);
  const out = await deps.runProbe(name, script);
  if (out.timedOut) return fail(504, 'probe timed out; the host is being reset');
  if (!out.ok) return fail(422, out.error);
  const pass = out.summary.results.every((r) => r.status === 'pass');
  return json(200, { name, evidence: `${EVIDENCE_REL}/${name}`, pass, summary: out.summary });
}

async function reset(req, deps) {
  const gate = bodyGate(req);
  if (gate) return gate;
  let spec;
  try {
    spec = parseResetBody(req.body, deps.resolveFixtureFile);
  } catch (err) {
    return fail(400, err instanceof Error ? err.message : String(err));
  }
  if (deps.busy()) return fail(409, 'busy');
  const out = await deps.reset(spec);
  if (!out.ok) return fail(500, out.error);
  return json(200, { status: 'ready', fixture: out.fixture });
}

/** Route one request. `/novnc/*` and the `/websockify` upgrade are handled by the supervisor before this. */
export async function routeRequest(req, deps) {
  const url = new URL(req.url, 'http://serve.invalid');
  if (url.pathname === '/health') return req.method === 'GET' ? health(deps) : fail(405, 'method not allowed');
  if (!allowedHost(req.headers.host, deps.hostPort)) return fail(403, 'host not allowed');
  if (!allowedOrigin(req.headers.origin, deps.hostPort)) return fail(403, 'origin not allowed');
  const methods = { '/': 'GET', '/probe': 'POST', '/reset': 'POST' };
  if (!(url.pathname in methods)) return fail(404, 'not found');
  if (req.method !== methods[url.pathname]) return fail(405, 'method not allowed');
  if (url.pathname === '/') {
    return { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: renderViewPage({ state: deps.state(), fixture: deps.fixture() }) };
  }
  return url.pathname === '/probe' ? probe(req, url.searchParams, deps) : reset(req, deps);
}
