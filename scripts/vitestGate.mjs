// Run a vitest gate; on failure re-judge the failing tests against the merge base.
// Usage: node scripts/vitestGate.mjs <vitest args...>   (see scripts/vitestDrift.mjs)
// Exit: the vitest status, or 0 when every failure also fails at the base (develop drift).

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { changedSince, git as gitFn, mergeBase } from './gateScope.mjs';
import { isCleanRun, loadPassInput, planScope, gitDirOf, scopeLine, snapshotTree, stateKey, writeState } from './gateState.mjs';
import { alertLine, allFailuresParsed, cacheKey, classifyFailures, classifyRerun, failingTestIds, flakeNotice, planFlakeRerun, fileOfId, planBaseCheck, ranTests, reportLines, slowestLines } from './vitestDrift.mjs';

const git = gitFn;

// No output for this long means a hung test file: kill the run and name the last output, not wait for the gate wall.
const IDLE_MS = Number(process.env.KARST_GATE_IDLE_MS) || 10 * 60_000;

const skip = (reason, ids) => {
  console.error(`base check skipped: ${reason}`);
  return ids;
};

/** Directories from `from` up to the filesystem root. */
function ancestors(from) {
  const out = [];
  for (let d = resolve(from); !out.includes(d); d = dirname(d)) out.push(d);
  return out;
}

/** The nearest directory (self or ancestor) whose node_modules holds vitest: where Node's upward lookup finds the full deps. */
function depsRoot(cwd) {
  return ancestors(cwd).find((d) => existsSync(join(d, 'node_modules', 'vitest'))) ?? null;
}

/** The nearest node_modules/.bin/<name> from cwd upward, so a partial node_modules still finds the repository's vitest. */
function localBinOf(cwd, name) {
  for (const d of ancestors(cwd)) {
    const bin = join(d, 'node_modules', '.bin', name);
    if (existsSync(bin)) return bin;
  }
  return null;
}

/** The directories that hold the base worktree, in order: below the deps root (never under .git), else tmpdir. */
function baseParent(cwd) {
  const root = depsRoot(cwd);
  if (root === null) return tmpdir();
  const parent = join(root, '.karst', 'base-check');
  mkdirSync(parent, { recursive: true });
  return parent;
}

/** Run a command, teeing its output to ours while capturing it. */
function run(cmd, args, cwd) {
  return new Promise((done) => {
    let out = '';
    const binDirs = ancestors(cwd).map((d) => join(d, 'node_modules', '.bin'));
    // CI mode: a gate judges the tree and never writes it, so a missing snapshot fails instead of being written.
    const env = { ...process.env, CI: '1', PATH: `${binDirs.join(':')}:${process.env.PATH ?? ''}` };
    let execCmd = cmd;
    let execArgs = args;
    if (cmd === 'npx' && args.length > 0) {
      const localBin = localBinOf(cwd, args[0]);
      if (localBin !== null) {
        execCmd = localBin;
        execArgs = args.slice(1);
      }
    }
    const child = spawn(execCmd, execArgs, { cwd, env });
    let timer;
    let hung = false;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const last = out.trimEnd().split('\n').slice(-3).join(' | ');
        console.error(`gate hang: no output for ${Math.round(IDLE_MS / 1000)}s; killing vitest. Last output: ${last}`);
        hung = true;
        child.kill('SIGKILL');
      }, IDLE_MS);
    };
    const sink = (stream) => (chunk) => {
      arm();
      out += chunk;
      stream.write(chunk);
    };
    arm();
    child.stdout.on('data', sink(process.stdout));
    child.stderr.on('data', sink(process.stderr));
    child.on('error', () => (clearTimeout(timer), done({ status: 127, out, hung, signaled: false })));
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      done({ status: status ?? 1, out, hung, signaled: signal !== null });
    });
  });
}

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
};

/** Re-run these files at the base; the ids that fail there. */
async function redAtBase(cwd, sha, args, files) {
  const dir = mkdtempSync(join(baseParent(cwd), 'karst-base-'));
  try {
    if ((await git(cwd, ['worktree', 'add', '--detach', dir, sha])) === null) return null;
    if (existsSync(join(cwd, 'node_modules'))) symlinkSync(resolve(cwd, 'node_modules'), join(dir, 'node_modules'), 'dir');
    console.error(`re-running ${files.length} failing test file(s) at the merge base ${sha.slice(0, 12)}`);
    const once = async () => {
      const base = await run(args[0], [...args.slice(1), ...files], dir);
      if (!ranTests(base.out)) {
        console.error('base check inconclusive: vitest did not run the test files at the merge base');
        return null;
      }
      return new Set(failingTestIds(base.out));
    };
    const first = await once();
    if (first === null || first.size === 0) return first;
    // A red verdict is cached for every later ticket: confirm it, so a flaky base failure is not frozen in.
    console.error('re-running the red base tests once to rule out a flake');
    const second = await once();
    return second === null ? null : new Set([...first].filter((id) => second.has(id)));
  } finally {
    await git(cwd, ['worktree', 'remove', '--force', dir]);
    rmSync(dir, { recursive: true, force: true });
    await git(cwd, ['worktree', 'prune']);
  }
}

async function judge(cwd, args, output) {
  const ids = failingTestIds(output);
  // GitHub Actions enforces: a red develop push must fail the job, so no failure is excused as base drift.
  if (process.env.GITHUB_ACTIONS === 'true') return skip('GitHub Actions never excuses a failure as base drift', ids);
  if (!allFailuresParsed(output, ids)) {
    console.error('base check skipped: some vitest failures are not parseable test ids (file-level, unhandled or uncounted)');
    return null;
  }
  const { sha, tried } = await mergeBase(cwd);
  if (sha === null) return skip(`no merge base for ${tried.join(', ')}`, ids);
  const changed = await changedSince(cwd, sha);
  if (changed === null) return skip('git diff failed', ids);
  const touched = new Set(changed);
  const plan = planBaseCheck(ids, touched);
  if (plan.kind !== 'run') {
    console.error(`base check skipped: ${plan.reason}`);
    return ids;
  }
  const common = (await git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']))?.trim();
  if (!common) return skip('no git common dir', ids);
  const cacheDir = join(common, 'karst-base-red', sha);
  mkdirSync(cacheDir, { recursive: true });
  const slot = (id) => join(cacheDir, `${cacheKey(common, sha, id)}.json`);
  const cached = new Map(ids.map((id) => [id, readJson(slot(id))]));
  const missing = ids.filter((id) => cached.get(id) === null);
  const redNow = missing.length > 0 ? await redAtBase(cwd, sha, args, [...new Set(missing.map(fileOfId))]) : new Set();
  if (redNow === null) return skip('could not re-run the failing tests at the merge base', ids);
  const red = new Set(ids.filter((id) => (cached.get(id) ? cached.get(id).red : redNow.has(id))));
  for (const id of missing) writeFileSync(slot(id), JSON.stringify({ red: redNow.has(id) }));
  const verdict = classifyFailures(ids, red);
  for (const line of reportLines(verdict)) console.error(line);
  // Printed on every drift pass: the host dedupes per (project, base sha) when it writes the bulletin note,
  // so a note that failed to land is retried by the next ticket instead of being lost.
  if (verdict.drift.length > 0) console.error(alertLine(sha, verdict.drift));
  return verdict.breaks;
}

/** Re-run each remaining failing file once, alone, at the ticket HEAD; true when none of them still fails. */
async function flakeCheck(cwd, args, ids) {
  const plan = planFlakeRerun(ids);
  if (plan.kind !== 'run') {
    console.error(plan.reason);
    return false;
  }
  const alone = new Map();
  for (const file of plan.files) {
    console.error(`re-running ${file} alone to rule out a flake`);
    const r = await run(args[0], [...args.slice(1), file], cwd);
    alone.set(file, { status: r.status, failed: new Set(failingTestIds(r.out)) });
  }
  const { flaky, breaks } = classifyRerun(ids, alone);
  if (flaky.length > 0) console.error(flakeNotice(flaky));
  return breaks.length === 0;
}

/** The vitest args for a narrowed pass: `run` becomes `related --run --passWithNoTests`, then the files. Null when there is no `run`. */
export function scopedArgs(args, files) {
  const at = args.indexOf('run');
  if (at === -1) return null;
  return [...args.slice(0, at), 'related', ...args.slice(at + 1), '--run', '--passWithNoTests', ...files];
}

/** Decide the scope of this pass and print its one line. Never throws: any trouble makes the pass full. */
async function planPass(cwd, args, key) {
  const base = (await mergeBase(cwd)).sha;
  const dir = await gitDirOf(cwd);
  const tree = base === null || dir === null ? null : await snapshotTree(cwd);
  const store = tree === null ? null : { dir, tree, base };
  if (store === null) {
    console.error('full: no merge base or tree snapshot, so the run cannot be stored');
    return { store, runArgs: args, files: null };
  }
  const input = await loadPassInput(cwd, dir, key, base, tree);
  const plan = planScope({ ...input, force: process.env.KARST_GATE_FULL === '1' });
  if (plan.kind === 'full') {
    console.error(scopeLine('', plan));
    return { store, runArgs: args, files: null };
  }
  const files = [...new Set([...plan.paths, ...plan.failed])];
  const runArgs = files.length === 0 ? args : scopedArgs(args, files);
  if (runArgs === null) {
    console.error('full: the vitest args have no run command to narrow');
    return { store, runArgs: args, files: null };
  }
  console.error(scopeLine(process.env.npm_lifecycle_event ?? 'vitest', { ...plan, count: files.length }));
  return { store, runArgs, files };
}

/** Store what this run covered. A failed file stays failed for the next pass even when the base check or the flake re-run excused it. */
function storeRun(store, key, first) {
  if (store === null) return;
  const ids = failingTestIds(first.out);
  const clean = isCleanRun({ status: first.status, hung: first.hung, signaled: first.signaled, parsedAllFailures: first.status === 0 || allFailuresParsed(first.out, ids) });
  writeState(store.dir, key, { tree: store.tree, base: store.base, clean, failed: clean ? [...new Set(ids.map(fileOfId))] : [] });
}

async function main() {
  const args = process.argv.slice(2);
  const cwd = process.cwd();
  const key = stateKey(args);
  const pass = await planPass(cwd, args, key).catch((error) => {
    console.error(`full: scope planning failed: ${error.message}`);
    return { store: null, runArgs: args, files: null };
  });
  if (pass.files !== null && pass.files.length === 0) {
    storeRun(pass.store, key, { status: 0, out: '', hung: false, signaled: false });
    process.exit(0);
  }
  const first = await run(pass.runArgs[0], pass.runArgs.slice(1), cwd);
  for (const line of slowestLines(first.out)) console.error(line);
  const finish = (code) => {
    storeRun(pass.store, key, first);
    process.exit(code);
  };
  if (first.status === 0) finish(0);
  const remaining = await judge(cwd, args, first.out).catch(() => null);
  if (remaining === null || remaining.length === 0) finish(remaining === null ? first.status : 0);
  const ok = await flakeCheck(cwd, args, remaining).catch(() => false);
  finish(ok ? 0 : first.status);
}

if (process.argv[1] && process.argv[1].endsWith('vitestGate.mjs')) await main();
