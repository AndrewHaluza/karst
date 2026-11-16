/**
 * Give a graph node clone the dependencies its ticket worktree resolves
 * (@arch:GRAPHRUN). The plan comes from `depsPlan.ts`; this module applies it.
 *
 * - Node: a REAL `node_modules` directory whose entries are symlinks. Entries of
 *   the worktree's own `node_modules` come first, then each remaining entry of
 *   every ancestor `node_modules` (the chain Node walks), then the main
 *   checkout's. One link to a partial worktree folder gives the same
 *   MODULE_NOT_FOUND, because the worktree folder holds only part of the tree.
 *   Dot-entries (`.vite`, `.cache`) are skipped. `.bin` is a merge of every
 *   `.bin` folder in the chain.
 * - Other ecosystems: one symlink per planned `link` path.
 * - Editable trap: a link target whose links, `.pth` files or `__editable__`
 *   entries point into the ticket worktree or the main checkout would make the
 *   clone run the code of ANOTHER tree. Such a target is never linked.
 * - A missing, unsafe or stale link runs the plan's `setup` command in the clone
 *   (async, with a timeout), or returns a typed `failed` result. It never throws
 *   for a dependency problem: a throw parks with the default reason and gets
 *   three automatic retries, each one a full install.
 *
 * Every created path goes into `<clone>/.git/info/exclude`, so `git status` of
 * the clone stays empty. A link target is never written and never removed.
 */

import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { isPathUnder } from '../../../runtime/pathScope.js';
import { checkNodeDeps } from '../../../workflow/gates/depsCheck.js';
import type { GateProcessRunner } from '../../../workflow/gates/run.js';
import type { GraphWorkspaceDef } from '../../../manifest/types.js';
import { planCreatedPaths, planIsEmpty, planWorkspaceDeps, resolvePlanPath, type DepsPlan } from './depsPlan.js';

/** The setup command may run a full install: generous, but never unbounded. */
export const WORKSPACE_SETUP_TIMEOUT_MS = 10 * 60 * 1000;
/** The tail of the setup output kept in a failure reason. */
export const SETUP_OUTPUT_TAIL_CHARS = 400;
/** Bounds of the editable scan of one link target. */
const EDITABLE_SCAN_MAX_DEPTH = 6;
const EDITABLE_SCAN_MAX_ENTRIES = 20_000;
const EDITABLE_FILE_MAX_BYTES = 64 * 1024;

export type SetupOutcome = { ok: true } | { ok: false; detail: string };

/** Runs the plan's setup command in `cwd`. Injected; the host binds `runWorkspaceSetup`. */
export type RunSetup = (command: string, cwd: string) => Promise<SetupOutcome>;

export type WorkspaceDepsResult =
  | { kind: 'ready'; created: string[] }
  | { kind: 'failed'; reason: string };

export interface WorkspaceDepsInput {
  repoName: string;
  /** The clone directory. */
  clone: string;
  /** The ticket worktree the clone was cut from. */
  worktree: string;
  /** The main checkout the worktree resolves up to, when known. */
  mainCheckout?: string;
  /** The repository's explicit `graphWorkspace` block. */
  explicit?: GraphWorkspaceDef;
}

export interface WorkspaceDepsDeps {
  runSetup: RunSetup;
  debug?: (message: string) => void;
}

/** `<root>/.git` of a worktree's common dir → the main checkout, or undefined. */
export function mainCheckoutOf(gitCommonDir: string | null): string | undefined {
  if (gitCommonDir === null) return undefined;
  const trimmed = gitCommonDir.replace(/[\\/]+$/, '');
  return /[\\/]\.git$/.test(trimmed) ? dirname(trimmed) : undefined;
}

/** Adapt a process runner to a `RunSetup`: shell, timeout, exit code, output tail. */
export function runWorkspaceSetup(
  run: GateProcessRunner,
  options: { timeoutMs?: number; onDebug?: (message: string) => void } = {},
): RunSetup {
  const win = process.platform === 'win32';
  return async (command, cwd) => {
    const outcome = await run(win ? 'cmd.exe' : 'sh', win ? ['/d', '/c', command] : ['-c', command], cwd, {
      timeoutMs: options.timeoutMs ?? WORKSPACE_SETUP_TIMEOUT_MS,
      onDebug: options.onDebug,
    });
    if (outcome.kind === 'completed' && outcome.exitCode === 0) return { ok: true };
    const tail = outputTail(outcome.kind === 'spawnFailed' ? `${outcome.message} ${outcome.output}` : outcome.output);
    if (outcome.kind === 'completed') return { ok: false, detail: `exit ${outcome.exitCode}${tail}` };
    if (outcome.kind === 'timedOut') return { ok: false, detail: `timed out${tail}` };
    if (outcome.kind === 'aborted') return { ok: false, detail: `aborted${tail}` };
    return { ok: false, detail: `could not start${tail}` };
  };
}

function outputTail(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat === '') return '';
  return `: ${flat.length > SETUP_OUTPUT_TAIL_CHARS ? `…${flat.slice(-SETUP_OUTPUT_TAIL_CHARS)}` : flat}`;
}

/* ------------------------------------------------------------------ */
/* Node merge                                                          */
/* ------------------------------------------------------------------ */

function isDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

function listDir(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

/** The directories Node resolves `node_modules` from: the worktree up to the root, then the main checkout. */
export function resolveChain(worktree: string, mainCheckout?: string): string[] {
  const dirs: string[] = [];
  for (let dir = worktree; ; dir = dirname(dir)) {
    dirs.push(dir);
    if (dirname(dir) === dir) break;
  }
  if (mainCheckout !== undefined && !dirs.includes(mainCheckout)) dirs.push(mainCheckout);
  return dirs;
}

/** One merged entry: its path inside `node_modules` and the real path it links to. */
interface MergeEntry {
  name: string;
  target: string;
  /** The `node_modules` folder the entry came from. */
  root: string;
}

/** The entries of the chain's `node_modules` folders; the nearest folder wins a name. */
export function collectNodeEntries(chain: readonly string[]): { entries: MergeEntry[]; bins: MergeEntry[] } {
  const seen = new Set<string>();
  const seenBins = new Set<string>();
  const entries: MergeEntry[] = [];
  const bins: MergeEntry[] = [];
  for (const dir of chain) {
    const root = join(dir, 'node_modules');
    if (!isDirectory(root)) continue;
    for (const name of listDir(root)) {
      if (name === '.bin') {
        for (const bin of listDir(join(root, name))) {
          if (seenBins.has(bin)) continue;
          seenBins.add(bin);
          bins.push({ name: bin, target: join(root, name, bin), root });
        }
        continue;
      }
      if (name.startsWith('.')) continue;
      if (name.startsWith('@')) {
        for (const pkg of listDir(join(root, name))) {
          const key = `${name}/${pkg}`;
          if (seen.has(key)) continue;
          seen.add(key);
          entries.push({ name: key, target: join(root, name, pkg), root });
        }
        continue;
      }
      if (seen.has(name)) continue;
      seen.add(name);
      entries.push({ name, target: join(root, name), root });
    }
  }
  return { entries, bins };
}

function safeRealpath(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

/** The first of `roots` a real path lies under, or undefined. */
function underAny(real: string, roots: readonly string[]): string | undefined {
  return roots.find((root) => isPathUnder(real, root));
}

/**
 * Entries that are links into the ticket worktree or the main checkout, outside
 * the tree they came from: npm/yarn workspace links. A pnpm link inside its own
 * store is not one.
 */
function workspaceLinkHits(entries: readonly MergeEntry[], guarded: readonly string[]): string[] {
  const hits: string[] = [];
  for (const entry of entries) {
    let stat;
    try {
      stat = lstatSync(entry.target);
    } catch {
      continue;
    }
    if (!stat.isSymbolicLink()) continue;
    const real = safeRealpath(entry.target);
    if (real === undefined) continue;
    if (isPathUnder(real, entry.root)) continue;
    if (underAny(real, guarded) !== undefined) hits.push(`${entry.name} → ${real}`);
  }
  return hits;
}

function mergeNodeModules(clone: string, entries: readonly MergeEntry[], bins: readonly MergeEntry[]): void {
  const root = join(clone, 'node_modules');
  mkdirSync(root, { recursive: true });
  const link = (relative: string, target: string): void => {
    const real = safeRealpath(target);
    if (real === undefined) return;
    const dest = join(root, ...relative.split('/'));
    mkdirSync(dirname(dest), { recursive: true });
    symlinkSync(real, dest);
  };
  for (const entry of entries) link(entry.name, entry.target);
  for (const bin of bins) link(`.bin/${bin.name}`, bin.target);
}

/* ------------------------------------------------------------------ */
/* Editable trap                                                       */
/* ------------------------------------------------------------------ */

const EDITABLE_FILE = /(\.pth|\.egg-link)$|^__editable__/;

/** Absolute paths named by a `.pth` / `.egg-link` / `__editable__` file. */
function pathsInEditableFile(file: string): string[] {
  let text: string;
  try {
    text = readFileSync(file, 'utf8').slice(0, EDITABLE_FILE_MAX_BYTES);
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (isAbsolute(trimmed)) found.push(trimmed);
    for (const match of trimmed.matchAll(/['"]((?:\/|[A-Za-z]:[\\/])[^'"]+)['"]/g)) found.push(match[1]!);
  }
  return found;
}

/**
 * Whether anything inside `target` (a venv, a vendor folder) leads into one of
 * `guarded`: a symlink, or a path in an editable file. Returns the first hit.
 */
export function editableHit(target: string, guarded: readonly string[]): string | undefined {
  let visited = 0;
  const walk = (dir: string, depth: number): string | undefined => {
    for (const name of listDir(dir)) {
      if (++visited > EDITABLE_SCAN_MAX_ENTRIES) return undefined;
      const full = join(dir, name);
      let stat;
      try {
        stat = lstatSync(full);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) {
        const real = safeRealpath(full);
        if (real !== undefined && !isPathUnder(real, target) && underAny(real, guarded) !== undefined) {
          return `${full} → ${real}`;
        }
        continue;
      }
      if (stat.isDirectory()) {
        const inner = depth < EDITABLE_SCAN_MAX_DEPTH ? walk(full, depth + 1) : undefined;
        if (inner !== undefined) return inner;
      } else if (EDITABLE_FILE.test(name)) {
        for (const path of pathsInEditableFile(full)) {
          const real = safeRealpath(path) ?? resolve(path);
          if (!isPathUnder(real, target) && underAny(real, guarded) !== undefined) return `${full} → ${real}`;
        }
      }
    }
    return undefined;
  };
  return walk(target, 0);
}

/* ------------------------------------------------------------------ */
/* Apply                                                               */
/* ------------------------------------------------------------------ */

function sameBytes(a: string, b: string): boolean {
  try {
    return readFileSync(a).equals(readFileSync(b));
  } catch {
    return false;
  }
}

function addToGitExclude(clone: string, paths: readonly string[]): void {
  if (paths.length === 0) return;
  const file = join(clone, '.git', 'info', 'exclude');
  mkdirSync(dirname(file), { recursive: true });
  const present = existsSync(file) ? readFileSync(file, 'utf8').split(/\r?\n/) : [];
  const missing = paths.map((p) => `/${p}`).filter((line) => !present.includes(line));
  if (missing.length === 0) return;
  const lead = present.length > 0 && present[present.length - 1] !== '' ? '\n' : '';
  appendFileSync(file, `${lead}${missing.join('\n')}\n`);
}

/** Remove what this module created in the clone. `rmSync` never follows a symlink. */
function removeCreated(clone: string, paths: readonly string[]): void {
  for (const p of paths) rmSync(resolvePlanPath(clone, p), { recursive: true, force: true });
}

/** The first existing source of a link path: the worktree, then the main checkout. */
function linkSource(
  relative: string,
  roots: readonly string[],
): { root: string; path: string } | undefined {
  for (const root of roots) {
    const path = resolvePlanPath(root, relative);
    try {
      lstatSync(path);
      return { root, path };
    } catch {
      /* try the next root */
    }
  }
  return undefined;
}

/** Why a link could not be made. A `soft` problem is a link that a default plan
 *  skips when the worktree has no such folder (nothing to repair); a hard one
 *  needs a setup run or a park. */
interface Problem {
  text: string;
  soft: boolean;
}

interface Applied {
  created: string[];
  problems: Problem[];
}

function applyLinks(input: WorkspaceDepsInput, plan: DepsPlan, guarded: readonly string[]): Applied {
  const created: string[] = [];
  const problems: Problem[] = [];
  const roots = [input.worktree, ...(input.mainCheckout === undefined ? [] : [input.mainCheckout])];
  for (const relative of plan.link) {
    const source = linkSource(relative, roots);
    if (source === undefined) {
      problems.push({ text: `${relative} is missing in the worktree`, soft: plan.source !== 'manifest' && plan.setup === undefined });
      continue;
    }
    const real = safeRealpath(source.path);
    if (real === undefined) {
      problems.push({ text: `${relative} is a broken link in the worktree`, soft: false });
      continue;
    }
    const hit = editableHit(real, guarded);
    if (hit !== undefined) {
      problems.push({ text: `${relative} holds an editable or workspace link into another tree (${hit})`, soft: false });
      continue;
    }
    const stale = plan.setupWhen.find((file) => !sameBytes(resolvePlanPath(input.clone, file), resolvePlanPath(source.root, file)));
    if (stale !== undefined) {
      problems.push({ text: `${stale} differs from the copy beside ${relative}`, soft: false });
      continue;
    }
    const dest = resolvePlanPath(input.clone, relative);
    if (existsSync(dest)) {
      problems.push({ text: `${relative} already exists in the clone`, soft: true });
      continue;
    }
    mkdirSync(dirname(dest), { recursive: true });
    symlinkSync(real, dest);
    created.push(relative);
  }
  return { created, problems };
}

/** The Node merge and its checks. Returns the problems; `created` holds `node_modules` when linked. */
async function applyNode(input: WorkspaceDepsInput, guarded: readonly string[], debug?: (m: string) => void): Promise<Applied> {
  const chain = resolveChain(input.worktree, input.mainCheckout);
  const { entries, bins } = collectNodeEntries(chain);
  if (entries.length === 0) {
    return { created: [], problems: [{ text: 'no node_modules resolves from the worktree', soft: false }] };
  }
  const hits = workspaceLinkHits(entries, guarded);
  if (hits.length > 0) {
    return { created: [], problems: [{ text: `node_modules holds a workspace link into another tree (${hits[0]})`, soft: false }] };
  }
  if (existsSync(join(input.clone, 'node_modules'))) {
    debug?.(`[graph] workspace deps: ${input.repoName} clone already has node_modules — left as is`);
    return { created: [], problems: [] };
  }
  mergeNodeModules(input.clone, entries, bins);
  const check = await checkNodeDeps(input.clone, { onDebug: debug });
  if (!check.ok) {
    removeCreated(input.clone, ['node_modules']);
    return { created: [], problems: [{ text: `node_modules does not match package-lock.json: ${check.reason}`, soft: false }] };
  }
  return { created: ['node_modules'], problems: [] };
}

/**
 * Apply the dependency plan of one repository to its clone. Never throws for a
 * dependency problem: the result is `ready` or a typed `failed` with the reason.
 */
export async function provisionWorkspaceDeps(
  input: WorkspaceDepsInput,
  deps: WorkspaceDepsDeps,
): Promise<WorkspaceDepsResult> {
  const { debug } = deps;
  const plan = planWorkspaceDeps(input.worktree, input.explicit);
  if (planIsEmpty(plan)) {
    debug?.(`[graph] workspace deps: ${input.repoName} — no dependency folders to give (${plan.source})`);
    return { kind: 'ready', created: [] };
  }
  const guarded = [input.worktree, ...(input.mainCheckout === undefined ? [] : [input.mainCheckout])];
  const created: string[] = [];
  const problems: Problem[] = [];
  try {
    if (plan.node) {
      const node = await applyNode(input, guarded, debug);
      created.push(...node.created);
      problems.push(...node.problems);
    }
    const links = applyLinks(input, plan, guarded);
    created.push(...links.created);
    problems.push(...links.problems);
    const hard = problems.filter((problem) => !problem.soft).map((problem) => problem.text);
    // A setup with nothing to link has nothing to compare: it always runs.
    const alwaysSetup = plan.setup !== undefined && plan.link.length === 0 && !plan.node;
    if (hard.length === 0 && !alwaysSetup) {
      addToGitExclude(input.clone, planCreatedPaths(plan));
      debug?.(
        `[graph] workspace deps: ${input.repoName} — linked ${created.join(', ') || 'nothing'} (${plan.ecosystems.join(', ')})`,
      );
      return { kind: 'ready', created };
    }
    if (plan.setup === undefined) {
      removeCreated(input.clone, created);
      return {
        kind: 'failed',
        reason: `${input.repoName}: ${hard.join('; ')} — set graphWorkspace.setup, or install in the worktree`,
      };
    }
    // Setup writes its own folders: remove the links first so it can never write through one.
    removeCreated(input.clone, created);
    debug?.(
      `[graph] workspace deps: ${input.repoName} — running setup in the clone${hard.length > 0 ? ` (${hard.join('; ')})` : ''}`,
    );
    const outcome = await deps.runSetup(plan.setup, input.clone);
    if (!outcome.ok) {
      return { kind: 'failed', reason: `${input.repoName}: setup "${plan.setup}" failed — ${outcome.detail}` };
    }
    addToGitExclude(input.clone, planCreatedPaths(plan));
    return { kind: 'ready', created: [] };
  } catch (err) {
    removeCreated(input.clone, created);
    return { kind: 'failed', reason: `${input.repoName}: could not prepare dependencies — ${String(err)}` };
  }
}
