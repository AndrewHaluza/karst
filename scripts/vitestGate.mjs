// Run a vitest gate; on failure re-judge the failing tests against the merge base.
// Usage: node scripts/vitestGate.mjs <vitest args...>   (see scripts/vitestDrift.mjs)
// Exit: the vitest status, or 0 when every failure also fails at the base (develop drift).

import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { alertLine, allFailuresParsed, cacheKey, classifyFailures, failingTestIds, fileOfId, planBaseCheck, ranTests, reportLines } from './vitestDrift.mjs';

const exec = promisify(execFile);
const git = async (cwd, args) => {
  try {
    return (await exec('git', args, { cwd, maxBuffer: 1 << 26 })).stdout;
  } catch {
    return null;
  }
};

const BASE_CANDIDATES = ['origin/develop', 'develop', 'origin/main', 'main'];

async function mergeBase(cwd) {
  for (const ref of process.env.KARST_BASE_REF ? [process.env.KARST_BASE_REF] : BASE_CANDIDATES) {
    const out = await git(cwd, ['merge-base', ref, 'HEAD']);
    if (out) return out.trim();
  }
  return null;
}

/** Run a command, teeing its output to ours while capturing it. */
function run(cmd, args, cwd) {
  return new Promise((done) => {
    let out = '';
    const binDir = join(cwd, 'node_modules', '.bin');
    const env = { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` };
    let execCmd = cmd;
    let execArgs = args;
    if (cmd === 'npx' && args.length > 0) {
      const localBin = resolve(cwd, 'node_modules', '.bin', args[0]);
      if (existsSync(localBin)) {
        execCmd = localBin;
        execArgs = args.slice(1);
      }
    }
    const child = spawn(execCmd, execArgs, { cwd, env });
    const sink = (stream) => (chunk) => {
      out += chunk;
      stream.write(chunk);
    };
    child.stdout.on('data', sink(process.stdout));
    child.stderr.on('data', sink(process.stderr));
    child.on('error', () => done({ status: 127, out }));
    child.on('close', (status) => done({ status: status ?? 1, out }));
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
  const dir = mkdtempSync(join(tmpdir(), 'karst-base-'));
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
  if (!allFailuresParsed(output, ids)) {
    console.error('base check skipped: some vitest failures are not parseable test ids (file-level, unhandled or uncounted)');
    return false;
  }
  const sha = await mergeBase(cwd);
  if (sha === null) return false;
  const changed = await git(cwd, ['diff', '--name-only', '-z', sha]);
  const untracked = await git(cwd, ['ls-files', '-o', '--exclude-standard', '-z']);
  if (changed === null || untracked === null) return false;
  const touched = new Set(`${changed}\0${untracked}`.split('\0').filter(Boolean));
  const plan = planBaseCheck(ids, touched);
  if (plan.kind !== 'run') {
    console.error(`base check skipped: ${plan.reason}`);
    return false;
  }
  const common = (await git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']))?.trim();
  if (!common) return false;
  const cacheDir = join(common, 'karst-base-red', sha);
  mkdirSync(cacheDir, { recursive: true });
  const slot = (id) => join(cacheDir, `${cacheKey(common, sha, id)}.json`);
  const cached = new Map(ids.map((id) => [id, readJson(slot(id))]));
  const missing = ids.filter((id) => cached.get(id) === null);
  const redNow = missing.length > 0 ? await redAtBase(cwd, sha, args, [...new Set(missing.map(fileOfId))]) : new Set();
  if (redNow === null) return false;
  const red = new Set(ids.filter((id) => (cached.get(id) ? cached.get(id).red : redNow.has(id))));
  for (const id of missing) writeFileSync(slot(id), JSON.stringify({ red: redNow.has(id) }));
  const verdict = classifyFailures(ids, red);
  for (const line of reportLines(verdict)) console.error(line);
  // Printed on every drift pass: the host dedupes per (project, base sha) when it writes the bulletin note,
  // so a note that failed to land is retried by the next ticket instead of being lost.
  if (verdict.drift.length > 0) console.error(alertLine(sha, verdict.drift));
  return verdict.breaks.length === 0;
}

const args = process.argv.slice(2);
const first = await run(args[0], args.slice(1), process.cwd());
if (first.status === 0) process.exit(0);
const drift = await judge(process.cwd(), args, first.out).catch(() => false);
process.exit(drift ? 0 : first.status);
