#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const mode = process.argv[2] ?? 'auto';
const platform = process.platform;
const arch = process.arch;
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

/**
 * Where better-sqlite3 ACTUALLY lives, and the package root that owns it.
 *
 * A git worktree under `.karst/worktrees/<name>/` has no node_modules of its
 * own — Node resolves better-sqlite3 by walking up to the main checkout's tree.
 * Assuming `<this repo>/node_modules` therefore probed a path that cannot exist,
 * `mkdirSync` CREATED an empty stub package there, and `npm rebuild` run from the
 * worktree then saw a root with nothing installed, rebuilt nothing, and still
 * exited 0 ("rebuilt dependencies successfully"). The Electron-ABI prebuild left
 * by `rebuild:electron` survived untouched and every test died on the ABI check.
 *
 * Resolve the real package instead, and rebuild from the root that owns it.
 */
function locateBetterSqlite3() {
  const require = createRequire(import.meta.url);
  let manifestPath;
  try {
    manifestPath = require.resolve('better-sqlite3/package.json');
  } catch {
    console.error(
      'Cannot resolve better-sqlite3 from ' + scriptDir + '. Run `npm install` in the main checkout first.',
    );
    process.exit(1);
  }
  const moduleDir = dirname(manifestPath);
  // <installRoot>/node_modules/better-sqlite3 -> <installRoot>: the dir npm must
  // run in for `npm rebuild` to see this package as installed.
  const installRoot = resolve(moduleDir, '..', '..');
  return { moduleDir, installRoot };
}

const { moduleDir, installRoot } = locateBetterSqlite3();

function run(command, args, extraEnv = {}) {
  const result = spawnSync(command, args, {
    cwd: installRoot,
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv },
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function detectElectronRuntime() {
  // The devDependency electron version in an app's package.json is a build-time
  // artifact and can be absent entirely (Cursor's app package.json has no
  // `electron` field). Ask the app's own embedded Electron binary instead —
  // running it with ELECTRON_RUN_AS_NODE prints its actual process.versions,
  // which is the ground truth for the ABI this extension host will load against.
  // Explicit target wins (install-local.sh sets this per-IDE so it doesn't
  // depend on candidate-list order or on apps not covered below). A set-but-
  // missing target is a config error, never a reason to fall through: the
  // fallback picks whichever IDE is installed next and silently ships that
  // app's ABI, which only fails at activation in the app that was asked for.
  if (process.env.KARST_TARGET_APP_BINARY && !existsSync(process.env.KARST_TARGET_APP_BINARY)) {
    console.error(
      `KARST_TARGET_APP_BINARY set but no such file: ${process.env.KARST_TARGET_APP_BINARY}\n` +
        'Refusing to fall back to another installed IDE — that would build the wrong ABI.',
    );
    process.exit(1);
  }
  const candidates = [
    process.env.KARST_TARGET_APP_BINARY,
    '/Applications/Cursor.app/Contents/MacOS/Cursor',
    // VS Code renamed its macOS binary from `Electron` to `Code` (1.93+), so
    // probe the current name first, the legacy one after.
    '/Applications/Visual Studio Code.app/Contents/MacOS/Code',
    '/Applications/Visual Studio Code.app/Contents/MacOS/Electron',
    '/Applications/Visual Studio Code - Insiders.app/Contents/MacOS/Code',
    '/Applications/Visual Studio Code - Insiders.app/Contents/MacOS/Electron',
    '/Applications/Antigravity IDE.app/Contents/MacOS/Electron',
    process.env.VSCODE_APP_PATH
      ? join(process.env.VSCODE_APP_PATH, 'Contents', 'MacOS', 'Code')
      : null,
    process.env.VSCODE_APP_PATH
      ? join(process.env.VSCODE_APP_PATH, 'Contents', 'MacOS', 'Electron')
      : null,
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const result = spawnSync(candidate, ['-e', 'console.log(process.versions.modules + " " + process.versions.electron)'], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      encoding: 'utf8',
    });
    const line = result.stdout?.trim().split('\n').at(-1);
    const match = line?.match(/^(\d+) (\S+)$/);
    if (match) {
      return { abi: match[1], electronVersion: match[2], binary: candidate };
    }
  }

  return null;
}

/**
 * Fetch better-sqlite3's PUBLISHED prebuild for a runtime + version.
 *
 * better-sqlite3 uploads one artifact per (runtime, ABI, platform, arch) to its
 * GitHub releases, so an ABI it ships no vendored `bin/` folder for is usually
 * still one download away. Try that before a source rebuild: compiling needs a
 * full C++ toolchain (on Windows, MSVC plus a python3 node-gyp can find), which
 * a machine that only wants to RUN the extension has no reason to have.
 */
function tryPrebuildDownload(runtime, version) {
  const require = createRequire(join(moduleDir, 'package.json'));
  let binPath;
  try {
    binPath = require.resolve('prebuild-install/bin.js');
  } catch {
    return false;
  }

  const result = spawnSync(
    process.execPath,
    [binPath, '--runtime', runtime, '--target', version, '--platform', platform, '--arch', arch],
    { cwd: moduleDir, stdio: 'inherit' },
  );
  return result.status === 0;
}

function tryPrebuild(abi) {
  const releaseDir = join(moduleDir, 'build', 'Release');
  const releaseFile = join(releaseDir, 'better_sqlite3.node');
  const prebuildFile = join(moduleDir, 'bin', `${platform}-${arch}-${abi}`, 'better-sqlite3.node');

  mkdirSync(releaseDir, { recursive: true });

  if (existsSync(prebuildFile)) {
    copyFileSync(prebuildFile, releaseFile);
    console.log(`Copied better-sqlite3 prebuild for ABI ${abi} from ${prebuildFile}`);
    return true;
  }

  return false;
}

if (mode === 'electron') {
  // VS Code / Cursor extension hosts run Electron, not plain Node, and their
  // Electron version varies by app/release (VS Code 1.132 = Electron 42.7 =
  // ABI 146; Cursor 3.11 = Electron 40 = ABI 143). Detect the actual host's ABI
  // by running its embedded Electron binary rather than assuming a fixed
  // default — otherwise a stale prebuild silently ships the wrong ABI and only
  // fails at extension activation in the other app. better-sqlite3 ships
  // matching prebuilds (e.g. darwin-arm64-146); copy one into build/Release
  // (what bindings loads) instead of compiling, when available.
  const runtime = detectElectronRuntime();
  const abi = process.env.BETTER_SQLITE3_ABI ?? runtime?.abi ?? '140';
  if (tryPrebuild(abi)) {
    process.exit(0);
  }

  const electronVersion = process.env.ELECTRON_VERSION ?? runtime?.electronVersion;
  if (!electronVersion) {
    console.error(`No prebuild found for ABI ${abi} and unable to detect an Electron version for source rebuild.`);
    process.exit(1);
  }

  if (tryPrebuildDownload('electron', electronVersion)) {
    console.log(`Downloaded better-sqlite3 prebuild for Electron ${electronVersion} (ABI ${abi}, ${platform}-${arch})`);
    process.exit(0);
  }

  console.log(`No prebuild for ABI ${abi}; rebuilding better-sqlite3 for Electron ${electronVersion} (${arch})...`);
  run(npmCommand, ['exec', '--', 'electron-rebuild', '-f', '-w', 'better-sqlite3', '--version', electronVersion, '--arch', arch, '--module-dir', installRoot], {
    npm_config_build_from_source: 'true',
  });
  process.exit(0);
}

/**
 * Prove the addon this Node will actually load matches this Node's ABI.
 *
 * `npm rebuild` reports success even when it rebuilt nothing, so "it exited 0"
 * says nothing about what sits in build/Release. The addon only loads on the
 * first `new Database()`, not on require, so construct one. Runs in a child so a
 * hard ABI abort cannot take this script's own process down.
 */
function assertLoadableUnderNode() {
  const probe =
    "const D = require('better-sqlite3'); new D(':memory:').close();";
  const result = spawnSync(process.execPath, ['-e', probe], {
    cwd: installRoot,
    encoding: 'utf8',
  });
  if (result.status === 0) return;

  console.error(
    `better-sqlite3 still does not load under this Node (ABI ${process.versions.modules}) after rebuilding.\n` +
      (result.stderr?.trim() ?? ''),
  );
  process.exit(1);
}

if (mode === 'node') {
  const abi = process.env.BETTER_SQLITE3_ABI || process.versions.modules?.toString();
  if (!abi) {
    console.error('Unable to determine the current Node ABI for better-sqlite3.');
    process.exit(1);
  }

  if (tryPrebuild(abi)) {
    assertLoadableUnderNode();
    process.exit(0);
  }

  // Same reasoning as the electron branch: the published Node prebuild is what
  // `npm install` itself fetched, so ask for it by version before demanding a
  // toolchain this machine may not have.
  if (tryPrebuildDownload('node', process.versions.node)) {
    console.log(`Downloaded better-sqlite3 prebuild for Node ${process.versions.node} (ABI ${abi}, ${platform}-${arch})`);
    assertLoadableUnderNode();
    process.exit(0);
  }

  console.log(`No prebuild found for ABI ${abi}; rebuilding from source for Node...`);
  run(npmCommand, ['rebuild', 'better-sqlite3', '--build-from-source'], {
    npm_config_build_from_source: 'true',
  });
  assertLoadableUnderNode();
  process.exit(0);
}

console.error('Usage: node scripts/rebuild-better-sqlite3.mjs [electron|node]');
process.exit(1);
