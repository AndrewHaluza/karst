#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const mode = process.argv[2] ?? 'auto';
const platform = process.platform;
const arch = process.arch;
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

/**
 * Where better-sqlite3 ACTUALLY lives, and the package root that owns it.
 *
 * A git worktree (karst's `.karst/worktrees/<name>/` or a plain
 * `git worktree add`) has no node_modules of its own — Node resolves
 * better-sqlite3 by walking up to the main checkout's tree. Rebuilding from
 * THAT shared install is what lets one worktree's `npm test` flip the addon
 * out from under the main checkout's installer (and vice versa), so the
 * resolved install is materialized as a LOCAL copy first whenever it lives
 * outside this checkout; from then on every path below operates on the copy.
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

// originalModuleDir stays the anchor for resolving prebuild-install: the
// local copy does not carry that tool (it lives hoisted at the top level of
// the MAIN checkout's node_modules), but the download must still land in the
// copy's own build/Release.
let { moduleDir, installRoot } = locateBetterSqlite3();
const originalModuleDir = moduleDir;

function isWithin(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * If better-sqlite3 resolved to an install OUTSIDE this checkout (a worktree
 * with no node_modules of its own walking up to the main checkout's), copy
 * the package in locally so this checkout's rebuilds — and therefore this
 * checkout's `npm test` — never touch the shared addon again. The main
 * checkout itself resolves inside its own cwd and never materializes.
 */
function materializeLocalCopyIfNeeded() {
  const cwd = process.cwd();
  if (isWithin(cwd, installRoot)) return;
  const localDir = join(cwd, 'node_modules', 'better-sqlite3');
  rmSync(localDir, { recursive: true, force: true });
  mkdirSync(dirname(localDir), { recursive: true });
  const result = spawnSync('cp', ['-R', moduleDir, localDir], { stdio: 'inherit' });
  if (result.status !== 0) {
    console.error(`Failed to copy better-sqlite3 into ${localDir}.`);
    process.exit(1);
  }
  moduleDir = localDir;
  installRoot = resolve(localDir, '..', '..');
  console.log(
    `better-sqlite3 resolved outside this checkout (shared install at ${originalModuleDir}) — copied it locally to ${localDir} ` +
      'so rebuilds here never flip the main checkout\'s addon.',
  );
}

materializeLocalCopyIfNeeded();

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

function releaseAddonPath() {
  return join(moduleDir, 'build', 'Release', 'better_sqlite3.node');
}

/**
 * ABI cache (`build/.abi-cache`): the last addon this install VERIFIED, keyed
 * by target ABI + runtime version + a SHA-256 of the addon's bytes.
 *
 * The probe below is a `node -e` spawn on every `npm test` pretest; with 2-3
 * tickets (or worktrees) running `npm run test:unit` concurrently that spawn
 * multiplies. The cache lets node mode skip the probe ENTIRELY when the addon
 * on disk is byte-identical to the one last verified — a hash, not an mtime,
 * because a fresh `cp -R` materialize or a tar-extracted prebuild rewrites
 * mtimes while an external flip (another target's `rebuild:electron`, a
 * concurrent `npm test`) replaces the bytes. A hash match means the current
 * addon IS the verified one, whatever copied it; a mismatch falls through to
 * the probe, which remains the source of truth. The cache is never read for
 * correctness — only to skip a redundant probe — and a cache write failure is
 * swallowed, so a stale or missing cache degrades to today's behavior.
 */
function abiCachePath() {
  return join(moduleDir, 'build', '.abi-cache');
}

function hashAddon() {
  const addon = releaseAddonPath();
  if (!existsSync(addon)) return null;
  try {
    return createHash('sha256').update(readFileSync(addon)).digest('hex');
  } catch {
    return null;
  }
}

function abiCacheHits(abi, runtime) {
  try {
    const cache = JSON.parse(readFileSync(abiCachePath(), 'utf8'));
    return (
      cache !== null &&
      typeof cache === 'object' &&
      cache.abi === abi &&
      cache.runtime === runtime &&
      typeof cache.addonHash === 'string' &&
      cache.addonHash === hashAddon()
    );
  } catch {
    return false;
  }
}

function writeAbiCache(abi, runtime) {
  const addonHash = hashAddon();
  if (addonHash === null) return;
  try {
    mkdirSync(dirname(abiCachePath()), { recursive: true });
    writeFileSync(abiCachePath(), JSON.stringify({ abi, runtime, addonHash }), 'utf8');
  } catch {
    // A cache write must never fail a verified build.
  }
}

/**
 * The addon's OWN NODE_MODULE_VERSION, read by attempting to load it under
 * THIS node. An ABI match loads cleanly — the addon's ABI is then this
 * node's own — while a mismatch aborts BEFORE dlopen and names the addon's
 * version on stderr ("…compiled against a different Node.js version using
 * NODE_MODULE_VERSION <n>…"), so macOS code signing never interferes with
 * the verdict. A missing or unloadable addon is null. This is the same
 * probe install-local.sh's addon_abi uses, and the only one that works for
 * EVERY ABI.
 */
function addonAbi() {
  const addon = releaseAddonPath();
  if (!existsSync(addon)) return null;
  const result = spawnSync(process.execPath, ['-e', 'require(process.argv[1])', addon], {
    encoding: 'utf8',
  });
  if (result.status === 0) return process.versions.modules?.toString() ?? null;
  const match = /NODE_MODULE_VERSION[^\d]*(\d+)/.exec(result.stderr ?? '');
  return match ? match[1] : null;
}

/**
 * Make build/Release/better_sqlite3.node an ABI-`abi` addon for `target`
 * (`electron` or `node`), or exit 1.
 *
 * Every delivery path is VERIFIED on the actual addon afterwards: "the
 * command ran" is not "it delivered". prebuild-install in particular can
 * exit 0 with the destination untouched, and a stale wrong-ABI binary must
 * neither be skipped over by a download nor read as a delivery — so the
 * existing addon is removed up front whenever it is not already the target
 * ABI (which is also the fast path: an addon that already matches needs no
 * churn, and `npm test`'s pretest becomes a no-op when the addon is already
 * the Node one).
 */
function ensureAddonFor(target, abi, version) {
  const current = addonAbi();
  if (current === abi) {
    console.log(`better-sqlite3 addon already matches ABI ${abi} (${target})`);
    return;
  }
  if (current !== null) {
    console.log(`Removing stale better-sqlite3 addon (ABI ${current}) before rebuilding for ABI ${abi} (${target})...`);
  }
  rmSync(releaseAddonPath(), { force: true });

  if (tryPrebuild(abi)) {
    if (addonAbi() === abi) return;
    console.error(`Vendored prebuild for ABI ${abi} did not verify (got ${addonAbi() ?? 'nothing'}).`);
    rmSync(releaseAddonPath(), { force: true });
  }

  if (version !== null && tryPrebuildDownload(target, version)) {
    if (addonAbi() === abi) {
      console.log(`Downloaded better-sqlite3 prebuild for ${target} ${version} (ABI ${abi}, ${platform}-${arch})`);
      return;
    }
    console.error(
      `prebuild-install exited 0 but did not deliver an ABI ${abi} addon (got ${addonAbi() ?? 'nothing'}) — falling back to a source build.`,
    );
    rmSync(releaseAddonPath(), { force: true });
  }

  if (version === null) {
    console.error(`No prebuild found for ABI ${abi} and no ${target} version to build against — giving up.`);
    process.exit(1);
  }

  console.log(`No prebuild for ABI ${abi}; building better-sqlite3 for ${target} ${version} (${arch})...`);
  if (target === 'electron') {
    run(npmCommand, ['exec', '--', 'electron-rebuild', '-f', '-w', 'better-sqlite3', '--version', version, '--arch', arch, '--module-dir', installRoot], {
      npm_config_build_from_source: 'true',
    });
  } else {
    run(npmCommand, ['rebuild', 'better-sqlite3', '--build-from-source'], {
      npm_config_build_from_source: 'true',
    });
  }

  if (addonAbi() !== abi) {
    console.error(
      `better-sqlite3 still does not target ABI ${abi} (got ${addonAbi() ?? 'nothing'}) after the source build for ${target}.`,
    );
    process.exit(1);
  }
  console.log(`Built better-sqlite3 for ${target} ${version} (ABI ${abi}, ${platform}-${arch})`);
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
  // Resolve prebuild-install from the ORIGINAL install (the local copy made by
  // materializeLocalCopyIfNeeded does not carry it — it lives hoisted in the
  // main checkout's node_modules) but download into the CURRENT moduleDir, so
  // a worktree-local rebuild still receives the prebuild.
  const require = createRequire(join(originalModuleDir, 'package.json'));
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
  ensureAddonFor('electron', abi, runtime?.electronVersion ?? null);
  writeAbiCache(abi, runtime?.electronVersion ?? `electron-${abi}`);
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

  // Fast path: the addon on disk is byte-identical to the one last verified
  // for this ABI+runtime, so skip the probe spawn (and any rebuild) entirely.
  if (abiCacheHits(abi, process.version)) {
    console.log(`better-sqlite3 addon cache hit (ABI ${abi}, ${process.version}) — skipping probe`);
    process.exit(0);
  }

  ensureAddonFor('node', abi, process.versions.node ?? null);

  // The ABI probe proved the addon loads under this Node; prove it also
  // CONSTRUCTS a database, so `npm test` never fails on the first open.
  assertLoadableUnderNode();
  writeAbiCache(abi, process.version);
  process.exit(0);
}

console.error('Usage: node scripts/rebuild-better-sqlite3.mjs [electron|node]');
process.exit(1);
