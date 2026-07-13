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

function detectElectronVersion() {
  const candidates = [
    '/Applications/Visual Studio Code.app/Contents/Resources/app/package.json',
    '/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/package.json',
    process.env.VSCODE_APP_PATH ? join(process.env.VSCODE_APP_PATH, 'package.json') : null,
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      const pkg = JSON.parse(readFileSync(candidate, 'utf8'));
      const version = pkg.devDependencies?.electron ?? pkg.dependencies?.electron;
      if (version) {
        return version;
      }
    } catch {
      // Try the next candidate.
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
  const electronVersion = process.env.ELECTRON_VERSION ?? detectElectronVersion();
  if (!electronVersion) {
    console.error('Unable to detect an Electron version for better-sqlite3 rebuild.');
    process.exit(1);
  }

  console.log(`Rebuilding better-sqlite3 for Electron ${electronVersion} (${arch})...`);
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
