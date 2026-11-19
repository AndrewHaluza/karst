// Runs the TypeScript compiler resolved by Node module resolution, not a
// cwd-relative `node_modules/...` path: a ticket worktree inherits deps from an
// ancestor node_modules, which a literal relative file path never walks to.
//
// A `--noEmit` pass reuses tsc's own incremental result, with the build-info file
// under the worktree's git directory (as scripts/gateState.mjs does, @arch:GATE-REPEAT):
// the full program is still checked, only the unchanged part is reused, and the file
// never shows in the tree, the gate snapshot or `git status`. CI and KARST_GATE_FULL=1
// run full, so the gate keeps a full backstop.
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';

const HEAP_MB = 4096;
const STATE_DIR = 'karst-gate-state';
const BUILD_INFO = 'tsc.tsbuildinfo';

const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');

/** The git directory of `cwd` (`git rev-parse --absolute-git-dir`), or null when git fails. */
function gitDir(cwd) {
  const r = spawnSync('git', ['rev-parse', '--absolute-git-dir'], { cwd, encoding: 'utf8' });
  if (r.error || r.status !== 0) return null;
  const dir = r.stdout.trim();
  return dir === '' ? null : dir;
}

/** Whether the build-info file can be read as JSON; a missing file is fine (a first run). */
function buildInfoUsable(path) {
  if (!existsSync(path)) return true;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed !== null && typeof parsed === 'object';
  } catch {
    return false;
  }
}

/**
 * What to run: `{ args }` plus either `{ kind: 'incremental', path }` or `{ kind: 'full', reason }`
 * for the one scope line. The build-info file is deleted when it is unreadable, so a bad cache
 * never fails the gate.
 */
function planRun(args, env, cwd) {
  const full = (reason) => ({ kind: 'full', reason, args });
  if (!args.includes('--noEmit')) return full('not a --noEmit run');
  if (env.GITHUB_ACTIONS === 'true') return full('GITHUB_ACTIONS=true');
  if (env.KARST_GATE_FULL === '1') return full('KARST_GATE_FULL=1');
  if (args.includes('--incremental') || args.includes('--tsBuildInfoFile')) return full('the run sets its own incremental state');
  const dir = gitDir(cwd);
  if (dir === null) return full('not in a git work tree');
  const stateDir = join(dir, STATE_DIR);
  const path = join(stateDir, BUILD_INFO);
  if (!buildInfoUsable(path)) {
    rmSync(path, { recursive: true, force: true });
    return full('build info unreadable');
  }
  try {
    mkdirSync(stateDir, { recursive: true });
  } catch (error) {
    return full(`could not create ${stateDir}: ${error.message}`);
  }
  return { kind: 'incremental', path, args: [...args, '--incremental', '--tsBuildInfoFile', path] };
}

const plan = planRun(process.argv.slice(2), process.env, process.cwd());
// Synchronous: the child inherits fd 1, and `process.exit` below would drop a
// buffered async write when stdout is a pipe.
writeSync(1, plan.kind === 'incremental' ? `typecheck: incremental (${plan.path})\n` : `typecheck: full: ${plan.reason}\n`);
const r = spawnSync(process.execPath, [`--max-old-space-size=${HEAP_MB}`, tsc, ...plan.args], {
  stdio: 'inherit',
});
process.exit(r.status ?? 1);
