// Host lifecycle for the serve supervisor (arch:UATHOST-08): launch one live VS Code, stop it, and talk to it over a unix socket.
// All host preparation goes through hostPrep.mjs; nothing here copies code from run.mjs.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { killGroup, prepareUserData, seedFixture, startRun, writeCliShims } from './hostPrep.mjs';
import { UI_CDP_PORT } from './uiScript.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One JSON line out, one JSON line back, one connection per request. Resolves `{ timedOut: true }` when `timeoutMs` passes; rejects on a connect error. */
export function hostRequest(socketPath, obj, timeoutMs) {
  return new Promise((resolve, reject) => {
    const conn = connect(socketPath);
    let buf = '';
    let done = false;
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      conn.destroy();
      fn(value);
    };
    const timer = setTimeout(() => finish(resolve, { timedOut: true }), timeoutMs);
    conn.setEncoding('utf8');
    conn.on('connect', () => conn.write(`${JSON.stringify(obj)}\n`));
    conn.on('data', (chunk) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      try {
        finish(resolve, JSON.parse(buf.slice(0, nl)));
      } catch (err) {
        finish(reject, err);
      }
    });
    conn.on('error', (err) => finish(reject, err));
    conn.on('close', () => finish(reject, new Error('host channel closed without a reply')));
  });
}

/** Stop the host: mark the exit expected, kill the process group and the UI driver, remove the scratch root and the sockets. */
export async function stopHost(current) {
  if (!current) return;
  current.markExpected();
  killGroup(current.child.pid);
  if (current.uiDriver?.pid) {
    try { current.uiDriver.kill('SIGKILL'); } catch { /* already gone */ }
  }
  await current.exit;
  rmSync(current.root, { recursive: true, force: true });
  rmSync(current.hostSocket, { force: true });
  rmSync(current.uiSocket, { force: true });
}

function writeOptions({ root, vscodeExecutablePath, workspaceDir, tickets, dbPath, userData, extensionsDir, shimDir, fixtureFilePath }, ctx) {
  const optionsPath = join(root, 'tests-options.json');
  writeFileSync(optionsPath, JSON.stringify({
    vscodeExecutablePath,
    extensionDevelopmentPath: ctx.extRoot,
    extensionTestsPath: join(ctx.here, 'testRunnerServe.cjs'),
    extensionTestsEnv: {
      KARST_FAKE_CORE: '1',
      ...(fixtureFilePath ? { KARST_FAKE_CORE_SCRIPT: fixtureFilePath } : {}),
      PATH: `${shimDir}:${process.env.PATH}`,
      VSCODE_CLI: '1',
      UAT_EXPECT_TICKETS: String(tickets),
      UAT_DB_PATH: dbPath,
      KARST_UAT_PROBE: '1',
      UAT_SERVE_SOCKET: ctx.hostSocket,
      UAT_UI_SOCKET: ctx.uiSocket,
      ...(process.env.UAT_PROBE_TOTAL_MS ? { UAT_PROBE_TOTAL_MS: process.env.UAT_PROBE_TOTAL_MS } : {}),
      ...(process.env.UAT_PROBE_MAX_STEP_MS ? { UAT_PROBE_MAX_STEP_MS: process.env.UAT_PROBE_MAX_STEP_MS } : {}),
    },
    launchArgs: [
      workspaceDir,
      '--user-data-dir', userData,
      '--extensions-dir', extensionsDir,
      '--disable-extensions',
      '--disable-workspace-trust',
      '--no-sandbox',
      '--disable-gpu',
      `--remote-debugging-port=${UI_CDP_PORT}`,
    ],
  }));
  return optionsPath;
}

/** Poll `ping` until the in-host channel answers (Karst activated), the run exits, or the boot timeout passes. Returns the failure reason, or null. */
async function waitForPing(current, ctx) {
  let exited = null;
  current.exit.then((r) => { exited = r; });
  const deadline = Date.now() + ctx.bootTimeoutMs;
  while (Date.now() < deadline) {
    if (exited) return `the host exited during boot (${exited.code ?? exited.signal})`;
    try {
      const reply = await hostRequest(ctx.hostSocket, { op: 'ping' }, 2000);
      if (reply.ok === true) return null;
    } catch { /* the channel is not listening yet */ }
    await sleep(ctx.pingIntervalMs);
  }
  return `no answer within ${ctx.bootTimeoutMs} ms`;
}

/**
 * Launch one live host for `spec` (`{ fixture }` or `{ fixtureFile }`) and wait until it answers a ping.
 * Resolves the current host object; rejects with `host did not boot: <reason>` after cleaning up and setting the state to `failed`.
 */
export async function launchHost(spec, ctx) {
  const vscodeExecutablePath = process.env.UAT_VSCODE_BIN;
  if (!vscodeExecutablePath || !existsSync(vscodeExecutablePath)) {
    ctx.setState('failed');
    throw new Error('UAT_VSCODE_BIN is not set or missing: run serveServer.mjs through uat-serve-entrypoint.sh');
  }
  const root = mkdtempSync(join(tmpdir(), 'karst-uat-serve-'));
  let current;
  try {
    const shimDir = join(root, 'shims');
    writeCliShims(shimDir, { gh: true, nodePath: process.execPath, ghStubPath: join(ctx.here, 'ghStub.mjs') });
    const { userData, extensionsDir, dbPath } = prepareUserData(root, join(ctx.here, 'settings.json'));
    const fixtureFilePath = spec.fixtureFile;
    const { workspaceDir, tickets } = seedFixture({
      vscodeExecutablePath, extRoot: ctx.extRoot, fixture: spec.fixture, fixtureFilePath, fixtureRoot: join(root, 'fixture'), dbPath,
    });
    const optionsPath = writeOptions({ root, vscodeExecutablePath, workspaceDir, tickets, dbPath, userData, extensionsDir, shimDir, fixtureFilePath }, ctx);
    ctx.setState('booting');
    const uiDriver = spawn(process.execPath, [join(ctx.here, 'uiDriver.mjs'), '--socket', ctx.uiSocket, '--port', String(UI_CDP_PORT), '--out', ctx.uiStartOut], { stdio: 'inherit' });
    uiDriver.on('error', (err) => console.error(`uat-serve: ui driver failed — ${err.message}`));
    const { child, exit } = startRun(join(ctx.here, 'run.mjs'), optionsPath);
    let expected = false;
    current = { child, uiDriver, root, exit, hostSocket: ctx.hostSocket, uiSocket: ctx.uiSocket, markExpected: () => { expected = true; } };
    exit.then((r) => { if (!expected) ctx.onUnexpectedExit(r.code ?? r.signal); });
  } catch (err) {
    if (current) await stopHost(current);
    else rmSync(root, { recursive: true, force: true });
    ctx.setState('failed');
    throw new Error(`host did not boot: ${err instanceof Error ? err.message : err}`);
  }
  const reason = await waitForPing(current, ctx);
  if (reason) {
    await stopHost(current);
    ctx.setState('failed');
    throw new Error(`host did not boot: ${reason}`);
  }
  ctx.setState('ready');
  return current;
}
