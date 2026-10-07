#!/usr/bin/env node
// Shared staging helper for scripts/install-local.sh and scripts/package-remote.sh.
//
// Both installers need the same two things:
//
//   1. a 100%-fresh `npm run build` (never a cache, never an mtime stamp), and
//   2. a throwaway directory that contains ONLY what the vsix ships, so
//      `vsce package` walks a few thousand files instead of the repo's ~750k
//      (.karst worktrees, .stryker-tmp and friends live in the repo root).
//
// Doing it here — not in each shell script — is what lets the two run in any
// order, alone, on a fresh checkout, and concurrently: the build is serialized
// by a mkdir-based lock, each script uses its own stage directory, and packaging
// reads the stage copy, never the repo's shared node_modules/better-sqlite3
// addon. Neither script edits the repo's package.json.
//
// Usage:
//   node scripts/stage-vsix.mjs --stage-only --name <name>
//   node scripts/stage-vsix.mjs --name <name> --addon <path> --out <path>
//                                [--target <target>] [--reuse-stage]
//
// `--stage-only` builds and fills `.karst-cache/stage-<name>/`; a later
// `--reuse-stage` call adds an addon and packages without rebuilding (this is
// how install-local.sh builds once for every detected IDE). Without
// `--reuse-stage` the helper stages and packages in one call (package-remote.sh,
// and install-local's first IDE).
//
// The copy list is `scripts/stage-copy-list.json`: each entry is copied whole,
// so the staged tree mirrors a root-based vsce run (minus vsce's own
// defaultIgnore). See that file and src/ui/settings/app/packaging.test.ts.

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_DIR = join(ROOT, '.karst-cache');
const LOCK_DIR = join(CACHE_DIR, 'build.lock');
const COPY_LIST = JSON.parse(
  readFileSync(join(ROOT, 'scripts', 'stage-copy-list.json'), 'utf8'),
);

/** Default owner/stale policy. A full build is well under a minute, so a lock
 * older than this belonged to a crashed run (or a recycled pid) and is taken. */
const LOCK_STALE_MS = Number(process.env.KARST_BUILD_LOCK_STALE_MS ?? 15 * 60 * 1000);
const LOCK_WAIT_MS = Number(process.env.KARST_BUILD_LOCK_WAIT_MS ?? 30 * 60 * 1000);

function log(message) {
  console.log(`[stage-vsix] ${message}`);
}

function fail(message) {
  console.error(`[stage-vsix] ${message}`);
  process.exit(1);
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function parseArgs(argv) {
  const args = { name: null, target: null, reuseStage: false, stageOnly: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--name':
        args.name = argv[++i];
        break;
      case '--addon':
        args.addon = argv[++i];
        break;
      case '--out':
        args.out = argv[++i];
        break;
      case '--target':
        args.target = argv[++i];
        break;
      case '--reuse-stage':
        args.reuseStage = true;
        break;
      case '--stage-only':
        args.stageOnly = true;
        break;
      default:
        fail(`unknown argument '${arg}'`);
    }
  }
  if (!args.name || args.name === 'true') fail('--name is required');
  if (!args.stageOnly && (!args.addon || !args.out)) {
    fail('--addon and --out are required unless --stage-only is passed');
  }
  return args;
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: options.cwd ?? ROOT,
    stdio: 'inherit',
    env: { ...process.env, ...(options.env ?? {}) },
  });
  if (result.error) fail(`${command} failed to spawn: ${result.error.message}`);
  if (result.status !== 0) {
    fail(`${command} ${commandArgs.join(' ')} exited with ${result.status}`);
  }
}

// --- build lock -----------------------------------------------------------

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means a live process we may not signal; anything else (ESRCH) is dead.
    return err.code === 'EPERM';
  }
}

function lockIsStale() {
  try {
    const meta = JSON.parse(readFileSync(join(LOCK_DIR, 'owner.json'), 'utf8'));
    if (typeof meta.pid === 'number' && !processAlive(meta.pid)) return true;
    if (typeof meta.startedAt === 'number' && Date.now() - meta.startedAt > LOCK_STALE_MS) {
      return true;
    }
    return false;
  } catch {
    // No readable owner metadata: fall back to the lock directory's own age.
    try {
      return Date.now() - statSync(LOCK_DIR).mtimeMs > LOCK_STALE_MS;
    } catch {
      return false;
    }
  }
}

function acquireBuildLock() {
  mkdirSync(CACHE_DIR, { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(LOCK_DIR);
      writeFileSync(
        join(LOCK_DIR, 'owner.json'),
        JSON.stringify({ pid: process.pid, startedAt: Date.now() }),
      );
      log(`acquired build lock (pid ${process.pid})`);
      return;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (lockIsStale()) {
        log('removing a stale build lock (owner gone or older than the stale timeout)');
        rmSync(LOCK_DIR, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline) fail('timed out waiting for the build lock');
      sleepSync(250);
    }
  }
}

function releaseBuildLock() {
  rmSync(LOCK_DIR, { recursive: true, force: true });
}

// --- staging --------------------------------------------------------------

function git(args) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : '';
}

function buildInfo() {
  const commit8 = git(['rev-parse', '--short=8', 'HEAD']) || 'nogit';
  const dirty = git(['status', '--porcelain']).length > 0;
  return { commit8, dirty, builtAt: new Date().toISOString() };
}

function stageDir(name) {
  return join(CACHE_DIR, `stage-${name}`);
}

/**
 * Keep only the runtime dependency closure in the package, exactly as the repo
 * `.vscodeignore`'s `node_modules/**` block does. The stage copies the packages
 * whole (no pruning), but the install-only tree below is stubbed out, so this
 * negation list is what decides what actually ships.
 */
function writeStageVscodeIgnore(stage) {
  const rules = [
    'node_modules/**',
    ...COPY_LIST.nodeModulesPackages.map((name) => `!node_modules/${name}/**`),
  ];
  writeFileSync(join(stage, '.vscodeignore'), `${rules.join('\n')}\n`);
}

function concreteVersion(range) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(range ?? '');
  return match ? `${match[1]}.${match[2]}.${match[3]}` : '0.0.0';
}

/**
 * vsce's default dependency detection runs `npm list --production`, which fails
 * on ANY inconsistency — including a declared dependency that is deliberately
 * absent. The stage ships the runtime closure only, so better-sqlite3's
 * install-time `prebuild-install` and js-yaml's CLI-only `argparse` are missing
 * by design. Give each a dependency-free stub package.json (so `npm list` sees a
 * consistent tree) and let the stage `.vscodeignore` drop the stub from the
 * package. This is the "or equivalent" half of `--no-dependencies`: vsce's own
 * flag would drop node_modules entirely, losing the closure this VSIX needs.
 */
function ensureDependencyStubs(stage) {
  const seen = new Set();
  const queue = [...COPY_LIST.nodeModulesPackages];
  while (queue.length > 0) {
    const name = queue.pop();
    if (seen.has(name)) continue;
    seen.add(name);
    const manifestPath = join(stage, 'node_modules', name, 'package.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    for (const [dep, range] of Object.entries(manifest.dependencies ?? {})) {
      if (existsSync(join(stage, 'node_modules', dep))) {
        queue.push(dep);
        continue;
      }
      if (seen.has(`stub:${dep}`)) continue;
      seen.add(`stub:${dep}`);
      let version = concreteVersion(range);
      const realManifest = join(ROOT, 'node_modules', dep, 'package.json');
      if (existsSync(realManifest)) {
        try {
          version = JSON.parse(readFileSync(realManifest, 'utf8')).version ?? version;
        } catch {
          /* fall back to the range's floor */
        }
      }
      const stubDir = join(stage, 'node_modules', dep);
      mkdirSync(stubDir, { recursive: true });
      writeFileSync(
        join(stubDir, 'package.json'),
        `${JSON.stringify({ name: dep, version }, null, 2)}\n`,
      );
      log(`stubbed install-only dependency ${dep}@${version} for vsce's npm-list check`);
    }
  }
}

function fillStage(stage) {
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });

  for (const entry of COPY_LIST.required) {
    const source = join(ROOT, entry);
    if (!existsSync(source)) fail(`required stage entry is missing: ${entry}`);
    cpSync(source, join(stage, entry), { recursive: true });
  }
  for (const entry of COPY_LIST.optional) {
    const source = join(ROOT, entry);
    if (!existsSync(source)) continue;
    cpSync(source, join(stage, entry), { recursive: true });
  }

  writeStageVscodeIgnore(stage);
  ensureDependencyStubs(stage);

  // vsce runs `scripts.vscode:prepublish` (karst's runs a second full build) on
  // package. The build already happened, and the stage has no source to build,
  // so drop the hook from the staged manifest only — the repo's is untouched.
  const manifestPath = join(stage, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.scripts) delete manifest.scripts['vscode:prepublish'];
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const info = buildInfo();
  mkdirSync(join(stage, 'dist'), { recursive: true });
  writeFileSync(
    join(stage, 'dist', 'build-info.json'),
    `${JSON.stringify(info, null, 2)}\n`,
  );
  log(`staged ${stage} (build ${info.commit8}${info.dirty ? '-dirty' : ''})`);
  return info;
}

function buildAndStage(name) {
  const lock = acquireBuildLock();
  try {
    log('running full `npm run build`');
    run('npm', ['run', 'build']);
    return fillStage(stageDir(name));
  } finally {
    releaseBuildLock();
  }
}

function placeAddon(stage, addon) {
  const source = resolve(process.cwd(), addon);
  if (!existsSync(source)) fail(`addon not found: ${source}`);
  const destination = join(
    stage,
    'node_modules',
    'better-sqlite3',
    'build',
    'Release',
    'better_sqlite3.node',
  );
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination);
  log(`placed addon ${source}`);
}

function resolvedVsceBin() {
  const require = createRequire(import.meta.url);
  let manifestPath;
  try {
    manifestPath = require.resolve('@vscode/vsce/package.json');
  } catch {
    fail('@vscode/vsce is not installed — run `npm install` in the checkout before packaging');
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const relative = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.vsce;
  if (!relative) fail('@vscode/vsce declares no `vsce` bin');
  return join(dirname(manifestPath), relative);
}

function packageVsix(stage, out, target) {
  const outAbs = resolve(process.cwd(), out);
  const args = [
    resolvedVsceBin(),
    'package',
    '--skip-license',
    '--allow-missing-repository',
    // NOT --no-dependencies: that drops node_modules from the package entirely
    // (vsce's 'none' mode globs the cwd with node_modules ignored), losing the
    // external better-sqlite3 addon the extension needs at runtime. Dependency
    // detection is kept and made to pass by ensureDependencyStubs + the stage
    // .vscodeignore, which ships only the runtime closure.
    '--out',
    outAbs,
  ];
  if (target) args.push('--target', target);
  log(`packaging ${outAbs}${target ? ` (target ${target})` : ''}`);
  run(process.execPath, args, { cwd: stage });
  return outAbs;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const stage = stageDir(args.name);

  if (!args.stageOnly && args.reuseStage && !existsSync(stage)) {
    fail(`--reuse-stage was passed but ${stage} does not exist (run --stage-only first)`);
  }

  let info;
  if (args.reuseStage) {
    info = JSON.parse(readFileSync(join(stage, 'dist', 'build-info.json'), 'utf8'));
  } else {
    info = buildAndStage(args.name);
  }
  if (args.stageOnly) return;

  placeAddon(stage, args.addon);
  const outAbs = packageVsix(stage, args.out, args.target);
  log(`build ${info.commit8}${info.dirty ? '-dirty' : ''} (${info.builtAt})`);
  log(`VSIX: ${outAbs}`);
}

// Only run when executed directly — importing this module (packaging.test.ts
// reads stage-copy-list.json, not this file, but a future import must not build).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
}
