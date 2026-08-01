import type { GitRunner } from '../../integrations/git.js';
import type { LogError } from '../../logging/logger.js';
import type { WorktreeView } from '../../store/dashboard.js';

export interface WorktreeStats {
  repo: string;
  additions: number;
  deletions: number;
}

export type WorktreeStatsLoader = (
  worktrees: readonly WorktreeView[],
  signal?: AbortSignal,
) => Promise<WorktreeStats[]>;

/** Reduce numeric `git diff --numstat` rows; binary and malformed rows are omitted. */
export function parseNumstat(stdout: string): Omit<WorktreeStats, 'repo'> {
  let additions = 0;
  let deletions = 0;
  for (const line of stdout.split('\n')) {
    const [added, deleted] = line.split('\t', 3);
    if (!added || !deleted || !/^\d+$/.test(added) || !/^\d+$/.test(deleted)) continue;
    const nextAdditions = additions + Number(added);
    const nextDeletions = deletions + Number(deleted);
    if (!Number.isSafeInteger(nextAdditions) || !Number.isSafeInteger(nextDeletions)) continue;
    additions = nextAdditions;
    deletions = nextDeletions;
  }
  return { additions, deletions };
}

const REMOTE = 'origin';

function runGit(git: GitRunner, args: readonly string[], cwd: string, signal?: AbortSignal) {
  return signal ? git([...args], cwd, { signal }) : git([...args], cwd);
}

/**
 * The commit this branch was CUT FROM — never the base branch tip.
 *
 * `git diff <base>` is a two-dot diff, and against a base that has moved since
 * the cut it counts that movement BACKWARD: every line a teammate added to the
 * base becomes a deletion attributed to this worktree. Measured on this repo it
 * turned a `+1375 −16` branch into `+455 −11935`. A PR is a three-dot diff from
 * the merge base, so the panel must be one too or the two numbers describe
 * different questions while looking like the same one.
 *
 * `origin/<base>` is preferred for the same reason `mergeCheck` prefers it: the
 * local branch is whatever this clone last pulled, and a stale one moves the
 * merge base forward. Unlike `mergeCheck` this does NOT fetch — it repaints on
 * every dashboard refresh, and a network round trip per worktree per refresh is
 * not a price a passive counter may charge. A clone with no remote-tracking ref
 * falls back to the local branch rather than reporting nothing.
 */
async function resolveMergeBase(
  git: GitRunner,
  worktree: WorktreeView,
  baseRef: string,
  signal?: AbortSignal,
): Promise<string> {
  for (const ref of [`${REMOTE}/${baseRef}`, baseRef]) {
    const result = await runGit(git, ['merge-base', 'HEAD', ref], worktree.path, signal);
    const sha = result.exitCode === 0 ? result.stdout.trim() : '';
    if (sha) return sha;
  }
  throw new Error(`no merge base between HEAD and ${baseRef}`);
}

/**
 * Inspect every worktree independently so one missing ref or broken checkout
 * cannot suppress totals for its siblings. A mergebase-to-working-tree diff
 * includes committed and tracked staged/unstaged changes while leaving untracked
 * files out.
 */
export async function loadWorktreeStats(
  worktrees: readonly WorktreeView[],
  git: GitRunner,
  logError: LogError,
  signal?: AbortSignal,
): Promise<WorktreeStats[]> {
  const rows = await Promise.all(
    worktrees.map(async (worktree): Promise<WorktreeStats | null> => {
      if (!worktree.baseRef || signal?.aborted) return null;
      try {
        const mergeBase = await resolveMergeBase(git, worktree, worktree.baseRef, signal);
        const args = ['diff', '--numstat', '--no-ext-diff', mergeBase, '--'];
        const result = await runGit(git, args, worktree.path, signal);
        if (result.exitCode !== 0 || result.stdoutTruncated) {
          throw new Error(result.stderr || 'git diff output was truncated');
        }
        return { repo: worktree.repo, ...parseNumstat(result.stdout) };
      } catch (error) {
        if (signal?.aborted) return null;
        logError(`karst: could not read worktree stats for ${worktree.path}`, error);
        return null;
      }
    }),
  );
  return rows.filter((row): row is WorktreeStats => row !== null);
}
