/**
 * Cross-repository checks — the ones that need the whole map, not one entry.
 *
 * This is the silent-misconfig surface. Everything here produces, if unchecked,
 * a stack that comes up "successfully" wired to the wrong thing, or a spin that
 * dies half-way with a raw git error. Catching it at load time is the only place
 * the author still has the context to fix it.
 */

import { ManifestError } from '../error.js';
import type { Manifest, RepositoryDef } from '../types.js';
import { isRunnable } from '../runnable.js';

/**
 * Every `dependsOn` edge must reach a port that actually exists: the target must
 * be a known repository, it must declare a service (a non-runnable repository
 * has no port to bind to — this is the new model's contradiction), and that
 * service must own the named slot.
 */
function assertDependenciesResolve(repositories: Record<string, RepositoryDef>): void {
  for (const [name, repo] of Object.entries(repositories)) {
    if (!isRunnable(repo)) continue; // no service, no edges

    for (const [i, dep] of repo.service.dependsOn.entries()) {
      const where = `repository "${name}" service.dependsOn[${i}]`;
      const target = repositories[dep.target];

      if (!target) {
        throw new ManifestError(`${where} targets unknown repository "${dep.target}"`);
      }
      if (!isRunnable(target)) {
        throw new ManifestError(
          `${where} targets "${dep.target}", which declares no service — ` +
            `there is no port to bind to. Give "${dep.target}" a \`service:\` block ` +
            `or drop the dependency.`,
        );
      }
      if (!target.service.ports.some((p) => p.name === dep.port)) {
        const slots = target.service.ports.map((p) => p.name).join(', ');
        throw new ManifestError(
          `${where} references port "${dep.port}" on "${dep.target}", ` +
            `which has no such port slot (has: ${slots})`,
        );
      }
    }
  }
}

/**
 * Run every whole-graph check. Throws on the first fault found.
 *
 * Two repository entries MAY share a `repoPath` — a monorepo with several
 * runnable processes is expressed as two `repositories:` entries pointing at
 * the same directory, each with its own `service:`. The worktree slug is
 * per-TICKET (not per-repository), so they intentionally resolve to one
 * worktree; `spin`/`preflight`/`scope` dedup their worktree-creation loops by
 * repoPath for exactly that reason (53314d6, "fix: rename-invariant worktree
 * slug from ticket key+title"). Do not add a distinct-repoPath check here —
 * that was tried (see git history) and it broke the shared-repoPath case this
 * comment describes; the dedups are the correct fix, not a workaround.
 */
export function validateGraph(repositories: Record<string, RepositoryDef>): void {
  assertDependenciesResolve(repositories);
}

/**
 * A repository is "classified" once it declares at least one signal word. The
 * onboarding classify-gate uses this to decide whether to prompt for signals
 * before ticket onboarding proceeds. Applies to non-runnable repositories too —
 * a docs-only repo still has to be routable, or no ticket could reach it.
 */
export function isRepoClassified(repo: RepositoryDef): boolean {
  return (repo.signals ?? []).length > 0;
}

/** Names of repositories with no signal words yet. */
export function unclassifiedRepos(manifest: Manifest): string[] {
  return Object.entries(manifest.repositories)
    .filter(([, repo]) => !isRepoClassified(repo))
    .map(([name]) => name);
}
