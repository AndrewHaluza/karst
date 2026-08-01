import type { Manifest } from '../../manifest/types.js';
import type { GitRunner } from '../../integrations/git.js';
import { selectReviewTargets, type ReviewWorktree } from '../gates/targets.js';

/** One repository UAT runs its gates against. */
export interface UatTarget {
  /** The repository path the worktree row carries. */
  repo: string;
  /** The ticket's worktree for that repository — where the gates run. */
  path: string;
  /** Every manifest entry backed by this worktree (several for a monorepo). */
  names: string[];
}

/**
 * The repositories UAT runs against, built once per run.
 *
 * Reuses review's dependency-aware affected-target selection rather than a second
 * implementation: changing `api` can affect `web`, changing unrelated `docs`
 * cannot, and that propagation rule should have exactly one definition.
 *
 * Deduplicated by `repo` (the repoPath), because two `repositories:` entries
 * sharing a path are one monorepo with one worktree — running `npm test` twice
 * in the same directory answers the same question twice. This also protects
 * against a duplicated `worktrees` row for the same path (stale data, a
 * double-write): every name that maps to the path is preserved and merged,
 * never dropped, because service identity stays keyed by repository NAME
 * (distinct ports, distinct `servers` rows) and per-repository gate overrides
 * in `resolveUatGates` are keyed by that same name.
 *
 * Non-runnable repositories are included: they are still source trees with
 * suites, and `manifest/runnable.ts` draws the boot line separately.
 */
export async function planUatTargets(
  manifest: Manifest,
  worktrees: readonly ReviewWorktree[],
  git: GitRunner,
): Promise<UatTarget[]> {
  const selected = await selectReviewTargets(manifest, worktrees, git);
  const byPath = new Map<string, UatTarget>();
  for (const target of selected) {
    const existing = byPath.get(target.repo);
    if (existing) {
      for (const name of target.names) {
        if (!existing.names.includes(name)) existing.names.push(name);
      }
      continue;
    }
    byPath.set(target.repo, {
      repo: target.repo,
      path: target.path,
      names: [...target.names],
    });
  }
  return [...byPath.values()];
}
