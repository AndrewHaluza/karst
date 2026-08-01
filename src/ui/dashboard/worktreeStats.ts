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

/**
 * Inspect every worktree independently so one missing ref or broken checkout
 * cannot suppress totals for its siblings. A base-to-working-tree diff includes
 * committed and tracked staged/unstaged changes while leaving untracked files out.
 */
export async function loadWorktreeStats(
  worktrees: readonly WorktreeView[],
  git: GitRunner,
  logError: LogError,
): Promise<WorktreeStats[]> {
  const rows = await Promise.all(
    worktrees.map(async (worktree): Promise<WorktreeStats | null> => {
      if (!worktree.baseRef) return null;
      try {
        const result = await git(
          ['diff', '--numstat', '--no-ext-diff', worktree.baseRef, '--'],
          worktree.path,
        );
        if (result.exitCode !== 0 || result.stdoutTruncated) {
          throw new Error(result.stderr || 'git diff output was truncated');
        }
        return { repo: worktree.repo, ...parseNumstat(result.stdout) };
      } catch (error) {
        logError(`karst: could not read worktree stats for ${worktree.path}`, error);
        return null;
      }
    }),
  );
  return rows.filter((row): row is WorktreeStats => row !== null);
}
