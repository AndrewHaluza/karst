import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveInsideCheckout } from './args.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const FIXTURES = ['empty', 'ticket-mid-stage', 'blocked'];
const version = process.env.UAT_VSCODE_VERSION ?? '1.126.0';
const cachePath = resolve(process.env.UAT_VSCODE_CACHE ?? join(repoRoot, '.vscode-test'));

const argValue = (name) => {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
};

// `--print-vscode`: download (cached) and print the VS Code binary path, so the
// Docker entrypoint can rebuild the addon for that exact Electron ABI first.
if (process.argv.includes('--print-vscode')) {
  const { downloadAndUnzipVSCode } = await import('@vscode/test-electron');
  console.log(await downloadAndUnzipVSCode({ version, cachePath }));
  process.exit(0);
}

// `--inner-run-tests <options.json>`: the supervised half of a run. It owns the
// VS Code process, so it lives in its own process group (see startRun) and the
// hard timeout can reap the whole tree.
if (process.argv.includes('--inner-run-tests')) {
  const { runTests } = await import('@vscode/test-electron');
  try {
    await runTests(JSON.parse(readFileSync(argValue('--inner-run-tests'), 'utf8')));
  } catch (err) {
    console.error('uat-host: FAILED —', err instanceof Error ? err.message : err);
    process.exit(1);
  }
  process.exit(0);
}

const fixture = argValue('--fixture');
const scriptArg = argValue('--script');
const providerArg = argValue('--provider') ?? 'claude';
const launchMode = process.argv.includes('--launch-mode');
const outArg = argValue('--out');
if (!fixture || !FIXTURES.includes(fixture) || Boolean(scriptArg) !== Boolean(outArg)) {
  console.error(`usage: run.mjs --fixture <${FIXTURES.join('|')}> [--script <steps.json> --out <dir>]`);
  process.exit(2);
}
// Probe only when a script is given; the flag is what registers the command in the host.
// Both paths must stay inside the checkout: the Docker harness bind-mounts only
// the repo root, so a path outside it is discarded with the container and leaves
// nothing to cite. Resolve (and refuse) before the env below is built.
let probeScriptPath;
let probeOutPath;
if (scriptArg) {
  try {
    probeScriptPath = resolveInsideCheckout(scriptArg, repoRoot);
    probeOutPath = resolveInsideCheckout(outArg, repoRoot);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(2);
  }
}
const probeEnv = scriptArg
  ? { KARST_UAT_PROBE: '1', UAT_PROBE_SCRIPT: probeScriptPath, UAT_PROBE_OUT: probeOutPath }
  : {};
// runTests has no timeout of its own: this is the backstop so a wedged host can never hang the run.
const hardTimeoutMs = Number(process.env.UAT_PROBE_HARD_TIMEOUT_MS ?? 300_000);

// Loaded after arg validation so a bad fixture exits 2 without loading the module.
const { downloadAndUnzipVSCode } = await import('@vscode/test-electron');

/**
 * Runs the tests in a detached child that owns VS Code. `@vscode/test-electron`
 * spawns VS Code as its own child and wires no exit cleanup, so an in-process
 * race would leave the wedged host (and xvfb) running after we exit — the exact
 * hang the backstop exists to bound. A detached child is its own process group,
 * so SIGKILL on the group takes the whole tree down.
 */
function startRun(optionsPath) {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--inner-run-tests', optionsPath], {
    stdio: 'inherit',
    detached: true,
  });
  const exit = new Promise((r) => child.once('exit', (code, signal) => r({ code, signal, timedOut: false })));
  return { child, exit };
}

function killGroup(pid) {
  if (!pid) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
}

const root = mkdtempSync(join(tmpdir(), 'karst-uat-host-'));
const launchDir = join(root, 'launch');
mkdirSync(launchDir, { recursive: true });
// The dependency gate probes `<cli> --version` before any session opens. Launch
// mode never runs the real CLI, so no-op shims satisfy the probe; the stub is
// what actually runs.
const shimDir = join(root, 'shims');
if (launchMode) {
  mkdirSync(shimDir, { recursive: true });
  for (const cli of ['claude', 'codex', 'agy', 'opencode']) {
    const shim = join(shimDir, cli);
    writeFileSync(shim, '#!/bin/sh\nexit 0\n');
    chmodSync(shim, 0o755);
  }
}
let code = 1;
try {
  const userData = join(root, 'user-data');
  const extensionsDir = join(root, 'extensions');
  const dbPath = join(userData, 'User', 'globalStorage', 'karst.karst', 'karst.db');
  mkdirSync(join(userData, 'User'), { recursive: true });
  mkdirSync(extensionsDir, { recursive: true });
  copyFileSync(join(here, 'settings.json'), join(userData, 'User', 'settings.json'));

  const vscodeExecutablePath = await downloadAndUnzipVSCode({ version, cachePath });

  // Seed under the VS Code binary as plain Node so better-sqlite3 loads at the
  // Electron ABI the extension host will use (arch:ABI-01).
  const prep = spawnSync(
    vscodeExecutablePath,
    [join(repoRoot, 'dist', 'uat-host', 'prepare.js'), '--fixture', fixture, '--root', join(root, 'fixture'), '--provider', providerArg, '--db', dbPath],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8' },
  );
  if (prep.status !== 0) throw new Error(`prepare failed (${prep.status}): ${prep.stderr}`);
  const { workspaceDir, tickets } = JSON.parse(prep.stdout.trim().split('\n').pop());

  const optionsPath = join(root, 'tests-options.json');
  writeFileSync(optionsPath, JSON.stringify({
    vscodeExecutablePath,
    extensionDevelopmentPath: repoRoot,
    extensionTestsPath: join(here, 'testRunner.cjs'),
    extensionTestsEnv: {
      KARST_FAKE_CORE: launchMode ? 'launch' : '1',
      ...(launchMode
        ? { KARST_UAT_STUB_AGENT: join(repoRoot, 'dist', 'uat-host', 'stubAgent.js'), KARST_UAT_LAUNCH_DIR: launchDir, PATH: `${shimDir}:${process.env.PATH}` }
        : {}),
      UAT_EXPECT_TICKETS: String(tickets),
      UAT_DB_PATH: dbPath,
      ...probeEnv,
    },
    launchArgs: [
      workspaceDir,
      '--user-data-dir', userData,
      '--extensions-dir', extensionsDir,
      '--disable-extensions',
      '--disable-workspace-trust',
      '--no-sandbox',
      '--disable-gpu',
    ],
  }));

  const { child, exit } = startRun(optionsPath);
  let timer;
  const deadline = new Promise((r) => { timer = setTimeout(() => r({ timedOut: true }), hardTimeoutMs); });
  const outcome = await Promise.race([exit, deadline]);
  clearTimeout(timer);
  if (outcome.timedOut) {
    killGroup(child.pid);
    await exit; // reap so the inherited stdout flushes before we exit
    throw new Error(`hard timeout after ${hardTimeoutMs}ms`);
  }
  if (outcome.code !== 0) throw new Error(`tests failed (${outcome.code ?? outcome.signal})`);
  code = 0;
} catch (err) {
  console.error('uat-host: FAILED —', err instanceof Error ? err.message : err);
} finally {
  rmSync(root, { recursive: true, force: true });
}
process.exit(code);
