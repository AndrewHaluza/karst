import type { Manifest } from '../../manifest/types.js';
import type { GitRunner } from '../../integrations/git.js';
import { resolveBaselineBranchForPath } from '../../manifest/baselineBranch.js';

export interface ReviewWorktree {
  /** Repository path persisted on the worktree row. */
  repo: string;
  path: string;
  baseRef: string | null;
}

export interface ReviewTarget extends ReviewWorktree {
  /** Manifest entries backed by this worktree (several for a monorepo). */
  names: string[];
}

async function hasReviewChanges(git: GitRunner, cwd: string, base: string): Promise<boolean> {
  // Agents are allowed to leave implementation work uncommitted until ship.
  // Porcelain includes staged, unstaged, and untracked files, so review cannot
  // pass merely because HEAD itself has not moved yet.
  const status = await git(['status', '--porcelain'], cwd);
  if (status.exitCode !== 0) {
    throw new Error(
      `cannot determine review changes in ${cwd}: ${status.stderr || status.stdout || `git status exited ${status.exitCode}`}`,
    );
  }
  if (status.stdout.trim().length > 0) return true;

  // Prefer the fresh remote baseline. If fetch is unavailable, the local branch
  // is still a deterministic comparison when it exists; unlike ship's
  // conservative helper, a fetch failure must not label every repo as changed.
  const fetched = await git(['fetch', 'origin', base], cwd);
  const compare = fetched.exitCode === 0 ? `origin/${base}` : base;
  const diff = await git(['diff', '--quiet', `${compare}...HEAD`], cwd);
  if (diff.exitCode === 0) return false;
  if (diff.exitCode === 1) return true;
  const reason = diff.stderr || diff.stdout || fetched.stderr || fetched.stdout;
  throw new Error(
    `cannot determine review changes in ${cwd}: ${reason || `git diff exited ${diff.exitCode}`}`,
  );
}

/**
 * Select worktrees whose review checks can answer something about this ticket.
 *
 * Directly changed repositories seed the affected set. The set then expands
 * from a changed dependency to each runnable repository that depends on it,
 * transitively. This is the same direction an API/package change propagates:
 * changing `api` can affect `web`, while changing unrelated `docs` cannot.
 */
export async function selectReviewTargets(
  manifest: Manifest,
  worktrees: readonly ReviewWorktree[],
  git: GitRunner,
): Promise<ReviewTarget[]> {
  const namesByPath = new Map<string, string[]>();
  for (const [name, repository] of Object.entries(manifest.repositories)) {
    if (repository.enabled === false) continue;
    const names = namesByPath.get(repository.repoPath) ?? [];
    names.push(name);
    namesByPath.set(repository.repoPath, names);
  }

  const changed = new Set<string>();
  for (const worktree of worktrees) {
    const names = namesByPath.get(worktree.repo) ?? [];
    const base = resolveBaselineBranchForPath(manifest, worktree.repo);
    if (await hasReviewChanges(git, worktree.path, base)) {
      for (const name of names) changed.add(name);
    }
  }

  const affected = new Set(changed);
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const [name, repository] of Object.entries(manifest.repositories)) {
      if (affected.has(name) || repository.enabled === false || !repository.service) continue;
      if (repository.service.dependsOn.some((relation) => affected.has(relation.target))) {
        affected.add(name);
        expanded = true;
      }
    }
  }

  return worktrees.flatMap((worktree) => {
    const names = namesByPath.get(worktree.repo) ?? [];
    return names.some((name) => affected.has(name)) ? [{ ...worktree, names }] : [];
  });
}
