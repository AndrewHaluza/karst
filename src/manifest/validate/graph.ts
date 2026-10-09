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
import { resolveTarget, unitsOf } from '../runnable.js';

/**
 * Every `dependsOn` edge must reach a port that actually exists: the target must
 * be a known repository, it must declare a service (a non-runnable repository
 * has no port to bind to — this is the new model's contradiction), and that
 * service must own the named slot.
 */
function assertDependenciesResolve(repositories: Record<string, RepositoryDef>): void {
  for (const [name, repo] of Object.entries(repositories)) {
    if (repo.enabled === false) continue; // draft: not used by the system yet

    for (const unit of unitsOf(name, repo)) {
      const label = unit.repo === unit.key
        ? `repository "${name}" service`
        : `repository "${name}" services.${unit.name}`;
      for (const [i, dep] of unit.def.dependsOn.entries()) {
        const where = `${label}.dependsOn[${i}]`;
        const resolved = resolveTarget(repositories, dep.target);
        if ('error' in resolved) throw new ManifestError(`${where} ${resolved.error}`);
        const target = resolved.unit;
        if (target.key === unit.key) {
          throw new ManifestError(
            `${where} targets its own service "${unit.key}" — a service cannot depend on itself`,
          );
        }
        if (target.repoDef.enabled === false) {
          throw new ManifestError(
            `${where} targets "${dep.target}", which is disabled — enable it or drop the dependency.`,
          );
        }
        if (!target.def.ports.some((p) => p.name === dep.port)) {
          const slots = target.def.ports.map((p) => p.name).join(', ');
          throw new ManifestError(
            `${where} references port "${dep.port}" on "${dep.target}", ` +
              `which has no such port slot (has: ${slots})`,
          );
        }
      }
    }
  }
}

/**
 * Run every whole-graph check. Throws on the first fault found.
 *
 * Two repository entries MAY share a `repoPath` (legacy monorepo shape: two
 * `repositories:` entries, one `service:` each); the preferred monorepo shape is
 * ONE repository with a `services:` map. The worktree slug is
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
 * the ticket-form classify-gate uses this to decide whether to prompt for signals
 * before the ticket form proceeds. Applies to non-runnable repositories too —
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
