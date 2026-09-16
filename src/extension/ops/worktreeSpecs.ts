import type { WorktreeSpec } from '../../ui/diffs/git.js';
import { disambiguateLabels } from '../../ui/diffs/scmModel.js';

/** The persisted worktree fields this op needs. */
export interface WorktreeSpecInput {
  repo: string;
  path: string;
  branch: string | null;
  baseRef: string | null;
}

/**
 * Build the Source Control worktree specs for a ticket: render each repo's
 * display label through `displayRepo`, then make the labels unique within the
 * ticket so two worktrees cannot collide on a row URI.
 */
export function toWorktreeSpecs(
  worktrees: readonly WorktreeSpecInput[],
  displayRepo: (repo: string) => string,
): WorktreeSpec[] {
  return disambiguateLabels(
    worktrees.map((worktree) => ({
      label: displayRepo(worktree.repo),
      path: worktree.path,
      branch: worktree.branch,
      baseRef: worktree.baseRef,
    })),
  );
}
