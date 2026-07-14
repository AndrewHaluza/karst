#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(scriptDir, '..');
const mode = process.argv[2] ?? 'auto';
const platform = process.platform;
const arch = process.arch;
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function run(command, args, extraEnv = {}) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
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
  const candidates = [
    // Explicit target wins (install-local.sh sets this per-IDE so it doesn't
    // depend on candidate-list order or on apps not covered below).
    process.env.KARST_TARGET_APP_BINARY,
    '/Applications/Cursor.app/Contents/MacOS/Cursor',
    '/Applications/Visual Studio Code.app/Contents/MacOS/Electron',
    '/Applications/Visual Studio Code - Insiders.app/Contents/MacOS/Electron',
    '/Applications/Antigravity IDE.app/Contents/MacOS/Electron',
    process.env.VSCODE_APP_PATH ? join(process.env.VSCODE_APP_PATH, 'Contents/MacOS/Electron') : null,
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

function tryPrebuild(abi) {
  const moduleDir = join(rootDir, 'node_modules', 'better-sqlite3');
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
  // Electron version varies by app/release (VS Code 1.126 = Electron 39 = ABI
  // 140; Cursor 3.11 = Electron 40 = ABI 143). Detect the actual host's ABI by
  // running its embedded Electron binary rather than assuming a fixed default —
  // otherwise a stale prebuild silently ships the wrong ABI and only fails at
  // extension activation in the other app. better-sqlite3 ships matching
  // prebuilds (e.g. darwin-arm64-140); copy one into build/Release (what
  // bindings loads) instead of compiling, when available.
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

  console.log(`No prebuild for ABI ${abi}; rebuilding better-sqlite3 for Electron ${electronVersion} (${arch})...`);
  run(npmCommand, ['exec', '--', 'electron-rebuild', '-f', '-w', 'better-sqlite3', '--version', electronVersion, '--arch', arch, '--module-dir', rootDir], {
    npm_config_build_from_source: 'true',
  });
  process.exit(0);
}

if (mode === 'node') {
  const abi = process.env.BETTER_SQLITE3_ABI || process.versions.modules?.toString();
  if (!abi) {
    console.error('Unable to determine the current Node ABI for better-sqlite3.');
    process.exit(1);
  }

  if (tryPrebuild(abi)) {
    process.exit(0);
  }

  console.log(`No prebuild found for ABI ${abi}; rebuilding from source for Node...`);
  run(npmCommand, ['rebuild', 'better-sqlite3', '--build-from-source'], {
    npm_config_build_from_source: 'true',
  });
  process.exit(0);
}

console.error('Usage: node scripts/rebuild-better-sqlite3.mjs [electron|node]');
process.exit(1);
