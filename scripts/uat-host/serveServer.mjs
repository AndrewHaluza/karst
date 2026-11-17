// The serve supervisor (arch:UATHOST-08). It runs INSIDE the container, owns the one published port, the view processes
// and the live host lifecycle. serveApi.mjs routes; serveHost.mjs launches; hostChannel.cjs answers inside the host.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import http from 'node:http';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveInsideCheckout } from './args.mjs';
import {
  EVIDENCE_REL, MAX_BODY_BYTES, SERVE_CONTAINER_PORT, SERVE_FIXTURES, allowedHost, allowedOrigin, novncResponseHeaders, routeRequest,
} from './serveApi.mjs';
import { hostRequest, launchHost, stopHost } from './serveHost.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const WORK_ROOT = '/work';
const EXT_ROOT = resolve(here, '..', '..');
const DISPLAY_NUM = ':99';
const VNC_PORT = 5900;
const WEBSOCKIFY_PORT = 6080;
const HOST_SOCKET = '/tmp/karst-uat-serve-host.sock';
const UI_SOCKET = '/tmp/karst-uat-serve-ui.sock';
const UI_START_OUT = '/tmp/karst-uat-serve-ui-out';
const PING_INTERVAL_MS = 1000;
const BOOT_TIMEOUT_MS = Number(process.env.UAT_SERVE_BOOT_MS ?? 300000);
const PROBE_TOTAL_MS = Number(process.env.UAT_PROBE_TOTAL_MS ?? 120000);
const PROBE_BACKSTOP_MS = PROBE_TOTAL_MS + 60000;
const UI_CONTROL_TIMEOUT_MS = 5000;
const XVFB_WAIT_MS = 10000;
const HOST_PORT = Number(process.env.UAT_SERVE_HOST_PORT);
const DEFAULT_FIXTURE = 'ticket-mid-stage';

const log = (msg) => console.log(`uat-serve: ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function usageFail(reason) {
  console.error(`uat-serve: ${reason}`);
  process.exit(2);
}

function parseArgs(argv) {
  const value = (name) => {
    const at = argv.indexOf(name);
    return at >= 0 ? argv[at + 1] : undefined;
  };
  const fixture = value('--fixture');
  const fixtureFile = value('--fixture-file');
  if (fixture !== undefined && fixtureFile !== undefined) usageFail('--fixture and --fixture-file exclude each other');
  if (fixtureFile !== undefined) {
    try {
      return { fixtureFile: resolveInsideCheckout(fixtureFile, WORK_ROOT) };
    } catch (err) {
      return usageFail(err instanceof Error ? err.message : String(err));
    }
  }
  const name = fixture ?? DEFAULT_FIXTURE;
  if (!SERVE_FIXTURES.includes(name)) usageFail(`fixture must be one of ${SERVE_FIXTURES.join(', ')}`);
  return { fixture: name };
}

if (!Number.isInteger(HOST_PORT) || HOST_PORT < 1 || HOST_PORT > 65535) usageFail('UAT_SERVE_HOST_PORT must be a port number');
let currentSpec = parseArgs(process.argv.slice(2));

let state = 'booting';
let probeRunning = false;
let resetRunning = false;
let bootRunning = true; // the first launch: a reset now would start a second host
let current;
let shuttingDown = false;
const viewProcs = [];

const busy = () => probeRunning || resetRunning || bootRunning;
const fixtureLabel = (spec) => spec.fixture ?? relative(WORK_ROOT, spec.fixtureFile);

async function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  await stopHost(current).catch((err) => console.error(`uat-serve: stop failed — ${err.message}`));
  for (const p of viewProcs) { try { p.kill('SIGKILL'); } catch { /* already gone */ } }
  server.close();
  process.exit(code);
}

const hostCtx = {
  here, extRoot: EXT_ROOT, hostSocket: HOST_SOCKET, uiSocket: UI_SOCKET, uiStartOut: UI_START_OUT,
  pingIntervalMs: PING_INTERVAL_MS, bootTimeoutMs: BOOT_TIMEOUT_MS,
  setState: (s) => { state = s; },
  // A host that dies while ready and idle ends the container, so karst sees a dead service (Key Decision 16).
  onUnexpectedExit: (why) => {
    if (state !== 'ready' || resetRunning) return;
    console.error(`uat-serve: host exited unexpectedly (${why})`);
    void shutdown(1);
  },
};

async function reset(spec) {
  resetRunning = true;
  state = 'resetting';
  try {
    const next = spec && (spec.fixture || spec.fixtureFile) ? spec : currentSpec;
    await stopHost(current);
    current = undefined;
    current = await launchHost(next, hostCtx);
    currentSpec = next;
    return { ok: true, fixture: fixtureLabel(currentSpec) };
  } catch (err) {
    state = 'failed';
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    resetRunning = false;
  }
}

/** The evidence dir and every parent this probe created, owned by the operator after the run (the container runs as root). */
async function chownEvidence(dir, createdParents) {
  const { HOST_UID, HOST_GID } = process.env;
  if (!HOST_UID || HOST_UID === '0') return;
  const owner = `${HOST_UID}:${HOST_GID ?? HOST_UID}`;
  await chown(['-R', owner, dir]);
  if (createdParents.length > 0) await chown([owner, ...createdParents]);
}

function chown(args) {
  return new Promise((done) => {
    const p = spawn('chown', args, { stdio: 'inherit' });
    p.on('error', (err) => { console.error(`uat-serve: chown failed — ${err.message}`); done(); });
    p.on('exit', (code) => { if (code !== 0) console.error(`uat-serve: chown exited ${code}`); done(); });
  });
}

async function runProbe(name, script) {
  probeRunning = true;
  const dir = join(WORK_ROOT, EVIDENCE_REL, name);
  const createdParents = [];
  try {
    resolveInsideCheckout(dir, WORK_ROOT);
    for (let d = dirname(dir); d !== WORK_ROOT && !existsSync(d); d = dirname(d)) createdParents.unshift(d);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'script.json'), `${JSON.stringify(script, null, 2)}\n`);
    try {
      const ack = await hostRequest(UI_SOCKET, { control: 'setOut', outDir: dir }, UI_CONTROL_TIMEOUT_MS);
      if (ack.timedOut || ack.status !== 'pass') return { ok: false, error: 'ui driver setOut failed: no pass reply' };
    } catch (err) {
      return { ok: false, error: `ui driver setOut failed: ${err.message}` };
    }
    let reply;
    try {
      reply = await hostRequest(HOST_SOCKET, { op: 'run', scriptPath: join(dir, 'script.json'), outDir: dir }, PROBE_BACKSTOP_MS);
    } catch (err) {
      return { ok: false, error: `host channel unreachable: ${err.message}` };
    }
    if (reply.timedOut) {
      void reset(currentSpec); // a wedged host cannot run the next request
      return { timedOut: true };
    }
    if (!reply.ok) return { ok: false, error: reply.error };
    return { ok: true, summary: JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8')) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    await chownEvidence(dir, createdParents);
    probeRunning = false;
  }
}

const apiDeps = {
  state: () => state,
  fixture: () => fixtureLabel(currentSpec),
  instanceToken: process.env.KARST_INSTANCE_TOKEN || undefined,
  hostPort: HOST_PORT,
  busy,
  evidenceExists: (name) => existsSync(join(WORK_ROOT, EVIDENCE_REL, name)),
  runProbe,
  reset,
  resolveFixtureFile: (v) => resolveInsideCheckout(v, WORK_ROOT),
  onBackgroundResetFail: (error) => console.error(`uat-serve: background reset failed — ${error}`),
};

const sendJson = (res, status, obj) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
};

function proxyNovnc(req, res) {
  if (!allowedHost(req.headers.host, HOST_PORT) || !allowedOrigin(req.headers.origin, HOST_PORT)) {
    sendJson(res, 403, { error: allowedHost(req.headers.host, HOST_PORT) ? 'origin not allowed' : 'host not allowed' });
    return;
  }
  const upstream = http.request(
    { host: '127.0.0.1', port: WEBSOCKIFY_PORT, method: req.method, path: req.url.slice('/novnc'.length), headers: req.headers },
    (up) => {
      res.writeHead(up.statusCode ?? 502, novncResponseHeaders(up.headers));
      up.pipe(res);
    },
  );
  upstream.on('error', () => { if (!res.headersSent) sendJson(res, 502, { error: 'view unavailable' }); else res.destroy(); });
  req.pipe(upstream);
}

/** Collect the body, keeping at most MAX_BODY_BYTES + 1 bytes: routeRequest answers 413 for a longer one. */
function collectBody(req) {
  return new Promise((resolveBody) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      if (size > MAX_BODY_BYTES) return;
      chunks.push(c);
      size += c.length;
    });
    req.on('end', () => resolveBody(Buffer.concat(chunks).subarray(0, MAX_BODY_BYTES + 1).toString('utf8')));
    req.on('error', () => resolveBody(''));
  });
}

const server = http.createServer(async (req, res) => {
  if (req.url?.startsWith('/novnc/')) {
    proxyNovnc(req, res);
    return;
  }
  try {
    const body = await collectBody(req);
    const out = await routeRequest({ method: req.method, url: req.url ?? '/', headers: req.headers, body }, apiDeps);
    res.writeHead(out.status, out.headers);
    res.end(out.body);
  } catch (err) {
    console.error(`uat-serve: request failed — ${err instanceof Error ? err.message : err}`);
    if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
    else res.destroy();
  }
});

server.on('upgrade', (req, socket, head) => {
  const ok = req.url?.split('?')[0] === '/websockify' && allowedHost(req.headers.host, HOST_PORT) && allowedOrigin(req.headers.origin, HOST_PORT);
  if (!ok) {
    socket.destroy();
    return;
  }
  const upstream = connect(WEBSOCKIFY_PORT, '127.0.0.1');
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
  upstream.on('connect', () => {
    let raw = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) raw += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
    upstream.write(`${raw}\r\n`);
    if (head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
});

function startViewProcess(name, command, args) {
  const p = spawn(command, args, { stdio: 'inherit' });
  p.on('error', (err) => log(`${name} failed — ${err.message}`));
  p.on('exit', (code) => log(`${name} exited (${code})`));
  viewProcs.push(p);
  return p;
}

async function startDisplay() {
  startViewProcess('Xvfb', 'Xvfb', [DISPLAY_NUM, '-screen', '0', '1280x800x24', '-nolisten', 'tcp']);
  const deadline = Date.now() + XVFB_WAIT_MS;
  while (!existsSync(`/tmp/.X11-unix/X${DISPLAY_NUM.slice(1)}`)) {
    if (Date.now() > deadline) {
      console.error('uat-serve: Xvfb did not start');
      process.exit(1);
    }
    await sleep(100);
  }
  process.env.DISPLAY = DISPLAY_NUM;
  startViewProcess('x11vnc', 'x11vnc', ['-display', DISPLAY_NUM, '-localhost', '-rfbport', String(VNC_PORT), '-forever', '-shared', '-nopw', '-quiet']);
  startViewProcess('websockify', 'websockify', ['--web', '/usr/share/novnc', `127.0.0.1:${WEBSOCKIFY_PORT}`, `127.0.0.1:${VNC_PORT}`]);
}

process.stdin.resume();
process.stdin.on('end', () => void shutdown(0));
process.stdin.on('close', () => void shutdown(0));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => void shutdown(0));

await startDisplay();
// Listen before the first boot so /health answers 503 while the host starts.
await new Promise((ok) => server.listen(SERVE_CONTAINER_PORT, '0.0.0.0', ok));
try {
  current = await launchHost(currentSpec, hostCtx);
  bootRunning = false;
  log(`ready on container port ${SERVE_CONTAINER_PORT} (fixture ${fixtureLabel(currentSpec)})`);
} catch (err) {
  bootRunning = false;
  console.error(`uat-serve: FAILED — ${err instanceof Error ? err.message : err}`);
  await shutdown(1);
}
