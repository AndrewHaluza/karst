import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { GitRunner } from '../../integrations/git.js';
import { hasUiChange } from '../../workflow/gates/uiScope.js';

/**
 * Test what CI tests before a ship push (@arch:GATE-REPEAT, @arch:AC-39).
 *
 * On a `pull_request` event CI checks out the PR head merged with the CURRENT base. Karst's gates test the
 * branch alone. When the base moved after the last green gate run, CI tests a tree no karst gate saw. This
 * module builds that merge with `git merge-tree --write-tree` (read-only, the probe of `workflow/mergeCheck.ts`),
 * commits the merged tree detached with `commit-tree`, checks it out in a temporary worktree below
 * `.karst/base-check` and hands it to the caller's gate runner. The branch, its index and its working tree are
 * never touched, and the temporary worktree is always removed.
 *
 * Every escape that is not a verdict is `unknown`: the probe is advisory, so a probe that could not run never
 * blocks a push. Pure over the injected git runner.
 */

/** The merged tree a gate runner receives. */
export interface MergedTree {
  readonly cwd: string;
  readonly sha: string;
  readonly baseSha: string;
  /** Whether the base delta since the last green gate run holds a UI path; true when it could not be read. */
  readonly uiChanged: boolean;
}

export type BaseMovedOutcome =
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'no-baseline' }
  | { readonly kind: 'conflict'; readonly files: readonly string[] }
  | { readonly kind: 'passed'; readonly mergedSha: string }
  | { readonly kind: 'failed'; readonly mergedSha: string; readonly reason: string }
  | { readonly kind: 'unknown'; readonly reason: string };

export interface BaseMovedDeps {
  readonly git: GitRunner;
  /** The ticket worktree of the repository being pushed. */
  readonly cwd: string;
  readonly baseRef: string;
  /** The merge base the last green gate run saw (the gate state file); null when no green run left one. */
  readonly lastGreenBase: (cwd: string) => Promise<string | null>;
  /** The directory that holds the temporary worktree (`<deps root>/.karst/base-check`). */
  readonly worktreeParent: (cwd: string) => Promise<string>;
  /** Carries the last green gate states into the merged worktree so the gates scope to the delta; a failure only means a full run. */
  readonly seedState?: (seed: { cwd: string; mergedCwd: string; baseSha: string }) => Promise<void>;
  /** Runs the gates on the merged tree; null = passed, else the failure. */
  readonly runGates: (merged: MergedTree) => Promise<string | null>;
  readonly debug?: (message: string) => void;
}

const REMOTE = 'origin';
const SHA_SHOWN = 9;
const MESSAGE = 'karst: merged tree CI would test (never pushed)';
const IDENTITY = ['-c', 'user.name=karst', '-c', 'user.email=karst@localhost'];

const words = (r: { stderr: string; stdout: string; exitCode: number }): string =>
  r.stderr.trim() || r.stdout.trim() || `git exit ${r.exitCode}`;

/** The reason a failed merged run gives for the ship gate (@arch:SHIP-CI-ACTIONS offers the actions). */
export function baseMovedReason(baseRef: string, baseSha: string, failure: string): string {
  return `fails when merged with ${REMOTE}/${baseRef} ${baseSha.slice(0, SHA_SHOWN)}; CI tests this merge — ${failure}`;
}

export async function checkBaseMoved(d: BaseMovedDeps): Promise<BaseMovedOutcome> {
  try {
    return await run(d);
  } catch (err) {
    return { kind: 'unknown', reason: err instanceof Error ? err.message : String(err) };
  }
}

async function run(d: BaseMovedDeps): Promise<BaseMovedOutcome> {
  const { git, cwd, baseRef } = d;
  const fetched = await git(['fetch', REMOTE, baseRef], cwd);
  if (fetched.exitCode !== 0) return { kind: 'unknown', reason: words(fetched) };
  const head = await git(['rev-parse', 'HEAD'], cwd);
  const base = await git(['rev-parse', `${REMOTE}/${baseRef}`], cwd);
  const headSha = head.stdout.trim();
  const baseSha = base.stdout.trim();
  if (head.exitCode !== 0 || base.exitCode !== 0 || headSha === '' || baseSha === '') {
    return { kind: 'unknown', reason: words(head.exitCode !== 0 ? head : base) };
  }
  const seen = await d.lastGreenBase(cwd);
  if (seen === null) return { kind: 'no-baseline' };
  // The branch already holds the base tip: CI merges nothing new.
  const fork = await git(['merge-base', 'HEAD', `${REMOTE}/${baseRef}`], cwd);
  if (fork.exitCode === 0 && fork.stdout.trim() === baseSha) return { kind: 'unchanged' };

  const probe = await git(['merge-tree', '--write-tree', '--name-only', baseSha, headSha], cwd);
  if (probe.exitCode === 1) return { kind: 'conflict', files: conflictFiles(probe.stdout) };
  const [tree = ''] = probe.stdout.split('\n');
  if (probe.exitCode !== 0 || tree.trim() === '') return { kind: 'unknown', reason: words(probe) };

  const commit = await git([...IDENTITY, 'commit-tree', tree.trim(), '-p', headSha, '-p', baseSha, '-m', MESSAGE], cwd);
  const mergedSha = commit.stdout.trim();
  if (commit.exitCode !== 0 || mergedSha === '') return { kind: 'unknown', reason: words(commit) };

  const uiChanged = await baseDeltaHoldsUi(git, cwd, seen, baseSha, d.debug);
  const path = join(await d.worktreeParent(cwd), `merged-${randomBytes(4).toString('hex')}`);
  const added = await git(['worktree', 'add', '--detach', path, mergedSha], cwd);
  if (added.exitCode !== 0) return { kind: 'unknown', reason: words(added) };
  try {
    await seed(d, path, baseSha);
    const failure = await d.runGates({ cwd: path, sha: mergedSha, baseSha, uiChanged });
    return failure === null
      ? { kind: 'passed', mergedSha }
      : { kind: 'failed', mergedSha, reason: baseMovedReason(baseRef, baseSha, failure) };
  } finally {
    const removed = await git(['worktree', 'remove', '--force', path], cwd);
    if (removed.exitCode !== 0) d.debug?.(`[ship] base-check worktree ${path} not removed: ${words(removed)}`);
  }
}

/** Seeding is an optimisation: a failure keeps the gates full, never blocks. */
async function seed(d: BaseMovedDeps, mergedCwd: string, baseSha: string): Promise<void> {
  if (d.seedState === undefined) return;
  try {
    await d.seedState({ cwd: d.cwd, mergedCwd, baseSha });
  } catch (err) {
    d.debug?.(`[ship] base-check gate state not seeded (gates run in full): ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Conflicted paths: the lines right after the tree id, up to the first blank line (as `mergeCheck.ts`). */
function conflictFiles(stdout: string): string[] {
  const [, ...rest] = stdout.split('\n');
  const files: string[] = [];
  for (const raw of rest) {
    const line = raw.trim();
    if (line === '') break;
    files.push(line);
  }
  return files;
}

/** Not knowing the delta must never remove a check: an unreadable diff counts as a UI change. */
async function baseDeltaHoldsUi(git: GitRunner, cwd: string, from: string, to: string, debug?: (m: string) => void): Promise<boolean> {
  const diff = await git(['diff', '--name-only', '-z', from, to], cwd);
  if (diff.exitCode !== 0) {
    debug?.(`[ship] base delta unreadable (${words(diff)}): keeping every UI gate`);
    return true;
  }
  return hasUiChange(diff.stdout.split('\0').filter((p) => p !== ''));
}
