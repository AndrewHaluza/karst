import type { Manifest, RepositoryDef } from './types.js';
import { ManifestError } from './error.js';

/** Repository override first; the manifest value remains the project default. */
export function resolveBaselineBranch(
  manifest: Manifest,
  repository: RepositoryDef,
): string {
  return repository.baselineBranch ?? manifest.baselineBranch;
}

/**
 * Worktrees are keyed by repository path, while manifests are keyed by entry
 * name. Resolve the current branch at ship time so settings changed after the
 * worktree was created still control the PR target.
 */
export function resolveBaselineBranchForPath(
  manifest: Manifest,
  repoPath: string,
): string {
  const repository = Object.values(manifest.repositories).find(
    (candidate) => candidate.repoPath === repoPath,
  );
  return repository ? resolveBaselineBranch(manifest, repository) : manifest.baselineBranch;
}

/**
 * Several manifest entries may intentionally describe services in one monorepo,
 * but their single deduped worktree cannot have two branch points.
 */
export function assertSharedRepoBaselineBranches(
  repositories: Record<string, RepositoryDef>,
  defaultBranch: string,
): void {
  const seen = new Map<string, { name: string; branch: string }>();
  for (const [name, repository] of Object.entries(repositories)) {
    const branch = repository.baselineBranch ?? defaultBranch;
    const prior = seen.get(repository.repoPath);
    if (prior && prior.branch !== branch) {
      throw new ManifestError(
        `repositories "${prior.name}" and "${name}" share repoPath "${repository.repoPath}" ` +
          `but resolve to different baseline branches ("${prior.branch}" and "${branch}")`,
      );
    }
    seen.set(repository.repoPath, { name, branch });
  }
}
