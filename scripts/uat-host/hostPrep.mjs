// Shared host preparation (arch:UATHOST-01, arch:UATHOST-08): run.mjs (one-shot) and serveHost.mjs (serve) both call it.
// It must not import @vscode/test-electron: run.mjs loads that module late on purpose.
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SHIM_CLIS = ['claude', 'codex', 'agy', 'opencode'];

/** No-op CLI shims (and, with `gh`, the fake gh) so the dependency preflight passes without a real tool. */
export function writeCliShims(shimDir, { gh, nodePath, ghStubPath }) {
  mkdirSync(shimDir, { recursive: true });
  for (const cli of SHIM_CLIS) {
    const shim = join(shimDir, cli);
    writeFileSync(shim, '#!/bin/sh\nexit 0\n');
    chmodSync(shim, 0o755);
  }
  if (gh) {
    const ghShim = join(shimDir, 'gh');
    writeFileSync(ghShim, `#!/bin/sh\nexec "${nodePath}" "${ghStubPath}" "$@"\n`);
    chmodSync(ghShim, 0o755);
  }
}

/** The VS Code user-data and extensions dirs under `root`, with the host settings copied in. */
export function prepareUserData(root, settingsPath) {
  const userData = join(root, 'user-data');
  const extensionsDir = join(root, 'extensions');
  const dbPath = join(userData, 'User', 'globalStorage', 'karst.karst', 'karst.db');
  mkdirSync(join(userData, 'User'), { recursive: true });
  mkdirSync(extensionsDir, { recursive: true });
  copyFileSync(settingsPath, join(userData, 'User', 'settings.json'));
  return { userData, extensionsDir, dbPath };
}

/**
 * Seed under the VS Code binary as plain Node so better-sqlite3 loads at the
 * Electron ABI the extension host will use (arch:ABI-01).
 */
export function seedFixture({ vscodeExecutablePath, extRoot, fixture, fixtureFilePath, provider, fixtureRoot, dbPath }) {
  const prep = spawnSync(
    vscodeExecutablePath,
    [join(extRoot, 'dist', 'uat-host', 'prepare.js'), ...(fixtureFilePath ? ['--fixture-file', fixtureFilePath] : ['--fixture', fixture]), ...(provider ? ['--provider', provider] : []), '--root', fixtureRoot, '--db', dbPath],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8' },
  );
  if (prep.status !== 0) throw new Error(`prepare failed (${prep.status}): ${prep.stderr}`);
  return JSON.parse(prep.stdout.trim().split('\n').pop());
}

/**
 * Runs the tests in a detached child that owns VS Code. `@vscode/test-electron`
 * spawns VS Code as its own child and wires no exit cleanup, so an in-process
 * race would leave the wedged host (and xvfb) running after we exit — the exact
 * hang the backstop exists to bound. A detached child is its own process group,
 * so SIGKILL on the group takes the whole tree down.
 */
export function startRun(runMjsPath, optionsPath) {
  const child = spawn(process.execPath, [runMjsPath, '--inner-run-tests', optionsPath], {
    stdio: 'inherit',
    detached: true,
  });
  const exit = new Promise((r) => child.once('exit', (code, signal) => r({ code, signal, timedOut: false })));
  return { child, exit };
}

export function killGroup(pid) {
  if (!pid) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
}
