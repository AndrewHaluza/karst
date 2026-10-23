import type { Manifest } from '../manifest/types.js';
import type { WorktreeView } from '../store/dashboard.js';

/** A target's tree, as the parked run recorded it (or the primary `cwd`). */
export interface TargetTree {
  path: string;
  baseRef: string | null;
  branch: string | null;
}

/**
 * Resolve one asked repository to the tree it must be reviewed/tested in.
 *
 * A target with NO registered worktree row must never fall back to `cwd`: that
 * reviews or tests the primary checkout under another repository's name. The
 * only legitimate `cwd` substitution is the no-manifest path, where the stage
 * itself asked exactly `cwd` (so the repo it recorded IS that path). Anything
 * else is unresolvable and the caller parks instead of asking the wrong tree.
 */
export function targetTree(
  worktrees: readonly WorktreeView[],
  repo: string,
  cwd: string,
): TargetTree | null {
  const wt = worktrees.find((w) => w.repo === repo);
  if (wt) return { path: wt.path, baseRef: wt.baseRef, branch: wt.branch };
  return repo === cwd ? { path: cwd, baseRef: null, branch: null } : null;
}

/** The repos this run cannot ask, because the ticket has no worktree row for them. */
export function unresolvedTargets(
  worktrees: readonly WorktreeView[],
  repos: readonly string[],
  cwd: string,
): string[] {
  return repos.filter((repo) => targetTree(worktrees, repo, cwd) === null);
}

/**
 * Every manifest entry backed by this worktree path. The UAT stage derives the
 * same list while planning; the re-run has a store row's repoPath, so it maps
 * back to the names `unitsOf` needs to find the target's running services.
 */
export function manifestNamesFor(manifest: Manifest | undefined, repoPath: string): string[] {
  if (!manifest?.repositories) return [];
  return Object.entries(manifest.repositories)
    .filter(([, def]) => def.repoPath === repoPath)
    .map(([name]) => name);
}
