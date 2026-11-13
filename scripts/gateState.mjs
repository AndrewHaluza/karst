// Gate state for repeat UAT passes: what a finished gate run covered, kept under the
// worktree's git directory so a later pass can narrow to the delta (@arch:GATE-REPEAT).
// Pure planners are exported for tests; the git helpers never touch the real index or the working tree.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { git, splitZ } from './gateScope.mjs';

const exec = promisify(execFile);

/** Directory under the git directory that holds the gate state files. */
export const STATE_DIR = 'karst-gate-state';

/** Bump when the state shape changes: an older file reads as unreadable, so the pass is full. */
export const STATE_VERSION = 1;

const DEP_FILES = new Set(['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml']);
const CONFIG_FILE = /^(?:tsconfig[^/]*\.json|vitest[^/]*\.config\.[cm]?[jt]s)$/;
const CODE_FILE = /\.(?:[cm]?[jt]sx?)$/;

/** Stable key of a gate: the hash of its vitest args (or of the script name for a docker gate). */
export const stateKey = (args) => createHash('sha256').update(args.join('\0')).digest('hex').slice(0, 24);

/**
 * Where one changed path sends the pass: `{ kind: 'full', reason }`, `{ kind: 'code' }` (select tests by it)
 * or `{ kind: 'docs' }` (selects no test).
 */
export function classifyPath(path) {
  const base = path.split('/').pop();
  if (DEP_FILES.has(base)) return { kind: 'full', reason: `${path} changed (dependency file)` };
  if (CONFIG_FILE.test(base)) return { kind: 'full', reason: `${path} changed (test or type config)` };
  if (path.startsWith('scripts/vitest-')) return { kind: 'full', reason: `${path} changed (test setup)` };
  if (path.startsWith('docs/')) return { kind: 'docs' };
  if (!path.startsWith('src/')) return { kind: 'full', reason: `${path} changed (outside src and docs)` };
  if (!CODE_FILE.test(path)) return { kind: 'full', reason: `${path} changed (non-code file under src)` };
  return { kind: 'code' };
}

/**
 * The scope of a pass. `state` is the stored state (null when absent), `readable` false when the file or its
 * snapshot is gone, `delta` the `{status, path}` list between the snapshot and now (null when git failed).
 * A scoped plan carries `paths` (code files to relate) and `failed` (stored failing files).
 */
export function planScope({ state, readable = true, base, delta, force = false }) {
  const full = (reason) => ({ kind: 'full', reason });
  if (force) return full('KARST_GATE_FULL=1');
  if (state === null || state === undefined) return full('no earlier run');
  if (!readable) return full('earlier run state is unreadable');
  if (!state.clean) return full('earlier run was killed, hung or had failures that could not be parsed');
  if (base === null || base === undefined || state.base !== base) return full('the merge base moved');
  if (delta === null) return full('could not compare with the earlier run');
  const deleted = delta.find((d) => d.status.startsWith('D'));
  if (deleted) return full(`${deleted.path} was deleted or renamed`);
  const paths = [];
  for (const { path } of delta) {
    const where = classifyPath(path);
    if (where.kind === 'full') return full(where.reason);
    if (where.kind === 'code') paths.push(path);
  }
  return { kind: 'scoped', paths, failed: [...state.failed], since: state.tree };
}

/** A failed test that a sweep gate stored: `{ project, title }`, both non-empty strings. */
const isFailedTest = (f) =>
  f !== null && typeof f === 'object' && typeof f.project === 'string' && f.project !== '' && typeof f.title === 'string' && f.title !== '';

/**
 * Whether a sweep gate (visual, layout) may skip: it ran green at a snapshot, the merge base is the same, and
 * the delta since then holds no UI path. Anything else runs, with the reason for the scope line, or, with a usable
 * state, as a scoped run: the delta size, the snapshot, the delta `paths` and the stored `failed` tests
 * (`{ project, title }`; a red state never skips). A malformed failed entry makes the state unreadable.
 */
export function planSkip({ state, readable = true, base, delta, force = false, isUiPath }) {
  const run = (reason) => ({ kind: 'run', reason });
  if (force) return run('KARST_GATE_FULL=1');
  if (state === null || state === undefined) return run(readable ? 'no earlier green run' : 'earlier run state is unreadable');
  if (!readable) return run('earlier run state is unreadable');
  if (!state.clean) return run('earlier run was not green');
  if (base === null || base === undefined || state.base !== base) return run('the merge base moved');
  if (delta === null) return run('could not compare with the earlier run');
  if (!state.failed.every(isFailedTest)) return run('earlier run state is unreadable');
  const failed = state.failed.map(({ project, title }) => ({ project, title }));
  if (failed.length === 0 && !delta.some(({ path }) => isUiPath(path))) return { kind: 'skip', since: state.tree };
  return { kind: 'run', delta: delta.length, since: state.tree, paths: delta.map(({ path }) => path), failed };
}

/** True when the delta holds a path that can change a render (the `selectViews` UI paths). */
export const touchesUi = (delta, isUiPath) => delta.some(({ path }) => isUiPath(path));

/** The one scope line a gate prints. */
export function scopeLine(gate, plan) {
  if (plan.kind === 'full') return `full: ${plan.reason}`;
  if (plan.kind === 'skipped') return `skipped: no UI change since ${plan.since.slice(0, 12)}`;
  return `${gate}: ${plan.count} files, delta since ${plan.since.slice(0, 12)}`;
}

/**
 * Whether a finished run may seed the next narrowed pass. A run that was killed, hung, could not start,
 * or failed in a way the gate cannot parse must make the next pass full.
 */
export function isCleanRun({ status, hung = false, signaled = false, parsedAllFailures = true }) {
  if (hung || signaled || status === 137 || status === 127) return false;
  return status === 0 || parsedAllFailures;
}

/** The git directory of this worktree (a linked worktree has its own), or null. */
export async function gitDirOf(cwd) {
  const out = await git(cwd, ['rev-parse', '--path-format=absolute', '--git-dir']);
  return out && out.trim() ? out.trim() : null;
}

/**
 * The tree object of the whole working tree (tracked and untracked, ignored files left out), made with a
 * temporary index so the real index stays as it is. Null when git fails.
 */
export async function snapshotTree(cwd) {
  const dir = await gitDirOf(cwd);
  if (dir === null) return null;
  const index = join(dir, `karst-gate-index-${process.pid}-${Date.now()}`);
  const env = { ...process.env, GIT_INDEX_FILE: index };
  try {
    await exec('git', ['add', '-A'], { cwd, env, maxBuffer: 1 << 26 });
    const { stdout } = await exec('git', ['write-tree'], { cwd, env });
    return stdout.trim() || null;
  } catch {
    return null;
  } finally {
    rmSync(index, { force: true });
    rmSync(`${index}.lock`, { force: true });
  }
}

/** `{status, path}` entries between two trees (no rename detection: a rename is a delete plus an add), or null. */
export async function diffTrees(cwd, from, to) {
  const out = await git(cwd, ['diff-tree', '-r', '-z', '--name-status', '--no-renames', from, to]);
  if (out === null) return null;
  const tokens = splitZ(out);
  const delta = [];
  for (let i = 0; i + 1 < tokens.length; i += 2) delta.push({ status: tokens[i], path: tokens[i + 1] });
  return delta;
}

/** Whether the tree object still exists in this repository. */
export async function treeExists(cwd, tree) {
  return (await git(cwd, ['cat-file', '-e', `${tree}^{tree}`])) !== null;
}

const statePath = (dir, key) => join(dir, STATE_DIR, `${key}.json`);

/** The stored state of a gate: `{ state, readable }`; state null when no file exists, readable false when it cannot be used. */
export function readState(dir, key) {
  const path = statePath(dir, key);
  if (!existsSync(path)) return { state: null, readable: true };
  try {
    const state = JSON.parse(readFileSync(path, 'utf8'));
    const ok = state && state.version === STATE_VERSION && typeof state.tree === 'string' && Array.isArray(state.failed) && typeof state.clean === 'boolean';
    return ok ? { state, readable: true } : { state: null, readable: false };
  } catch {
    return { state: null, readable: false };
  }
}

/** Store the state atomically. A failure is reported on stderr and never fails the gate. */
export function writeState(dir, key, state) {
  try {
    mkdirSync(join(dir, STATE_DIR), { recursive: true });
    const path = statePath(dir, key);
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: STATE_VERSION, ...state }));
    renameSync(tmp, path);
  } catch (error) {
    console.error(`gate state not stored: ${error.message}`);
  }
}

/**
 * Read the stored state and compare it with `now`: the plan input for a pass.
 * Returns the `planScope` inputs minus `force`. A missing snapshot object makes the state unreadable.
 */
export async function loadPassInput(cwd, dir, key, base, now) {
  const { state, readable } = readState(dir, key);
  if (state === null || !readable) return { state, readable, base, delta: null };
  if (!(await treeExists(cwd, state.tree))) return { state, readable: false, base, delta: null };
  return { state, readable, base, delta: await diffTrees(cwd, state.tree, now) };
}
