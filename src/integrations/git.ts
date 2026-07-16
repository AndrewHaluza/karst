import { spawnSync } from 'node:child_process';

/**
 * Git integration for the stages that talk to a remote. The runner is injected so
 * ship logic stays unit-testable without a real repo or network; the default
 * runner shells out to `git`, inheriting the user's credentials.
 *
 * Local git plumbing (worktree create/remove) lives in `runtime/worktree.ts` and
 * does not belong here: that code is spawn-and-forget with no remote in sight.
 */

export interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type GitRunner = (args: string[], cwd: string) => Promise<GitResult>;

/** Default runner: `git <args>` in `cwd`. Never throws — the exit code is the answer. */
export const defaultGitRunner: GitRunner = async (args, cwd) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  const exitCode = r.status ?? 1;
  const spawnFailure = r.error ? `could not run git: ${r.error.message}` : '';
  return {
    stdout: r.stdout ?? '',
    stderr: r.stderr || spawnFailure || (exitCode !== 0 ? `git exited ${exitCode}` : ''),
    exitCode,
  };
};

/** `git <args>` in `cwd`, throwing git's own reason (never a bare colon) on failure. */
async function run(git: GitRunner, args: string[], cwd: string, what: string): Promise<string> {
  const r = await git(args, cwd);
  if (r.exitCode !== 0) {
    const reason = r.stderr.trim() || r.stdout.trim() || `git exit ${r.exitCode}`;
    throw new Error(`git ${what} failed in ${cwd}: ${reason}`);
  }
  return r.stdout;
}

/**
 * Commit whatever the agent left in the worktree, so the branch actually carries
 * the work. Returns whether anything was committed.
 *
 * Ship, not impl, owns this: a stage marker says the agent believes it is done,
 * not that it ran `git commit`. When it didn't, the branch has no commits and
 * `gh pr create` fails with "No commits between main and karst/…" — the work is
 * finished, reviewed, and unshippable. A clean tree is the normal case (the agent
 * committed its own work) and must not produce an empty commit.
 */
export async function commitAllIfDirty(
  git: GitRunner,
  cwd: string,
  message: string,
): Promise<boolean> {
  const status = await run(git, ['status', '--porcelain'], cwd, 'status');
  if (!status.trim()) return false;

  await run(git, ['add', '-A'], cwd, 'add');
  await run(git, ['commit', '-m', message], cwd, 'commit');
  return true;
}

/**
 * Publish the worktree's branch so a PR can be opened from it.
 *
 * `HEAD` rather than the branch name: it is what the worktree is actually on,
 * where the stored name is what karst believed at creation. `-u` sets upstream,
 * which is what `gh pr create` reads to find the head branch.
 *
 * Re-running is safe — an already-pushed, unchanged branch exits 0 ("Everything
 * up-to-date").
 */
export async function pushBranch(git: GitRunner, cwd: string): Promise<void> {
  await run(git, ['push', '-u', 'origin', 'HEAD'], cwd, 'push');
}
