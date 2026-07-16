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
  const r = await git(['push', '-u', 'origin', 'HEAD'], cwd);
  if (r.exitCode !== 0) {
    const reason = r.stderr.trim() || r.stdout.trim() || `git exit ${r.exitCode}`;
    throw new Error(`git push failed in ${cwd}: ${reason}`);
  }
}
