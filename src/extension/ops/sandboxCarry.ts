import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { GitRun } from './sandboxRewrite.js';

export interface CarryInput {
  readonly worktree: string;
  readonly recorded: string;
  readonly cloneHead: string;
  /** Host-private scratch dir for the patch file (ProcessRunOptions has no stdin). */
  readonly scratch: string;
}

export type CarryResult =
  | { readonly ok: true; readonly carried: number }
  | { readonly ok: false; readonly reason: 'dirty' | 'failed'; readonly message: string }
  | { readonly ok: false; readonly reason: 'conflict'; readonly paths: readonly string[] };

/**
 * Replays `<recorded>..<cloneHead>` onto the host worktree with `git am -3`.
 * On a conflict it stops and leaves the am state for the user: nothing is
 * forced, aborted or dropped.
 */
export async function carryCommits(run: GitRun, input: CarryInput): Promise<CarryResult> {
  const { worktree } = input;
  const range = `${input.recorded}..${input.cloneHead}`;
  const status = await run(worktree, ['status', '--porcelain', '--untracked-files=no']);
  if (status.code !== 0) return { ok: false, reason: 'failed', message: `git status failed: ${status.stderr.trim()}` };
  if (status.stdout.trim() !== '') return { ok: false, reason: 'dirty', message: 'the host worktree has uncommitted changes; commit or stash them first' };
  const count = await run(worktree, ['rev-list', '--count', range]);
  if (count.code !== 0) return { ok: false, reason: 'failed', message: `git rev-list failed: ${count.stderr.trim()}` };
  const carried = Number(count.stdout.trim());
  if (carried === 0) return { ok: true, carried };
  const patch = await run(worktree, ['format-patch', '--stdout', '--binary', range]);
  if (patch.code !== 0) return { ok: false, reason: 'failed', message: `git format-patch failed: ${patch.stderr.trim()}` };
  const dir = await mkdtemp(join(input.scratch, 'karst-carry-'));
  try {
    const file = join(dir, 'carry.patch');
    await writeFile(file, patch.stdout);
    const am = await run(worktree, ['am', '-3', file]);
    if (am.code === 0) return { ok: true, carried };
    const unmerged = await run(worktree, ['diff', '--name-only', '--diff-filter=U']);
    const paths = unmerged.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
    if (paths.length > 0) return { ok: false, reason: 'conflict', paths };
    return { ok: false, reason: 'failed', message: `git am failed: ${(am.stderr || am.stdout).trim()}` };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
