import { isAbsolute, join } from 'node:path';

/**
 * The directory a consented repo change runs in.
 *
 * A change proposal names its target as `repo` (the same field a manifest
 * repository key uses). For a repository already in the manifest, the target is
 * that repository's `repoPath`, resolved against the workspace root when
 * relative.
 *
 * For a NOT-yet-registered repository — greenfield's `git init` / `.env` /
 * install, before any manifest exists — `repo` is the directory name the user
 * named (`proposal.ts`: "a directory name for a not-yet-registered repo"). It
 * must resolve UNDER the workspace root, never fall back to the root itself: the
 * consent modal names `repo` ("Apply this change to \"web\"?"), so applying the
 * change one level up silently targets the wrong directory.
 *
 * Pure and host-agnostic so the resolution is unit-tested; the `vscode` binding
 * in `extension/setupWiring.ts` only supplies the root and the current manifest.
 */
export function resolveChangeRepoDir(
  repo: string,
  workspaceRoot: string,
  registeredRepoPath: string | undefined,
): string {
  if (registeredRepoPath !== undefined) {
    return isAbsolute(registeredRepoPath) ? registeredRepoPath : join(workspaceRoot, registeredRepoPath);
  }
  return join(workspaceRoot, repo);
}
