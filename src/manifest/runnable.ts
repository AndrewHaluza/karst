/**
 * The single place the codebase asks "can this repository run?".
 *
 * `RepositoryDef.service` is optional, so every consumer that starts, stops,
 * health-checks, or addresses something by port has to narrow before it can
 * touch `start`/`ports`/`health`/`dependsOn`. Doing that inline would scatter
 * `?.` and non-null assertions across the runtime layer — and a `!` on an
 * optional relation is exactly the bug this model exists to prevent (see
 * `spin.ts`'s old `svc.ports[0]!`, which threw a TypeError on any repository
 * without ports).
 *
 * Narrow here instead. `isRunnable` is a type guard, so once it passes the
 * compiler knows `service` is present and no assertion is needed.
 */

import type { Manifest, RepositoryDef, ServiceDef } from './types.js';

/**
 * One runnable process. `key` is its identity everywhere at runtime (servers,
 * port allocations, env overrides, resolver output): the bare repository name
 * for the single-`service:` shorthand, `repo/service` for a `services:` map
 * entry. The shorthand keeps its old key so existing single-service tickets,
 * registry rows and overrides are untouched.
 */
export interface ServiceUnit {
  key: string;
  repo: string;
  /** The service's own name — the repository name for the shorthand. */
  name: string;
  def: ServiceDef;
  repoDef: RepositoryDef;
}

/** Separator between repository and service in a unit key / dependsOn target. */
export const SERVICE_SEP = '/';

/** The runnable units of ONE repository (empty when it declares no service). */
export function unitsOf(repoName: string, repo: RepositoryDef): ServiceUnit[] {
  if (repo.service) {
    return [{ key: repoName, repo: repoName, name: repoName, def: repo.service, repoDef: repo }];
  }
  return Object.entries(repo.services ?? {}).map(([name, def]) => ({
    key: `${repoName}${SERVICE_SEP}${name}`,
    repo: repoName,
    name,
    def,
    repoDef: repo,
  }));
}

/** Type guard: does this repository declare at least one runnable service? */
export function isRunnable(repo: RepositoryDef): boolean {
  return repo.service !== undefined || Object.keys(repo.services ?? {}).length > 0;
}

/** Every runnable unit of the manifest, in declaration order. */
export function serviceUnits(manifest: Manifest): ServiceUnit[] {
  return Object.entries(manifest.repositories).flatMap(([name, repo]) => unitsOf(name, repo));
}

/** The unit for `key` (`repo` or `repo/service`), or undefined. */
export function unitByKey(manifest: Manifest, key: string): ServiceUnit | undefined {
  return serviceUnits(manifest).find((u) => u.key === key);
}

/** The repository name a unit key belongs to (`api/web` → `api`). */
export function repoOfKey(manifest: Manifest, key: string): string {
  return unitByKey(manifest, key)?.repo ?? key.split(SERVICE_SEP)[0]!;
}

/**
 * Resolve a `dependsOn.target` (`repo` or `repo/service`) against the
 * repositories. `repo` alone is valid only when that repository has exactly one
 * service; `repo/service` names one. Returns the reason on failure so the
 * validator can state it.
 */
export function resolveTarget(
  repositories: Record<string, RepositoryDef>,
  target: string,
): { unit: ServiceUnit } | { error: string } {
  const sep = target.indexOf(SERVICE_SEP);
  const repoName = repositories[target] ? target : sep < 0 ? target : target.slice(0, sep);
  const repo = repositories[repoName];
  if (!repo) return { error: `targets unknown repository "${repoName}"` };
  const units = unitsOf(repoName, repo);
  if (units.length === 0) {
    return {
      error:
        `targets "${repoName}", which declares no service — there is no port to bind to. ` +
        `Give "${repoName}" a \`service:\` block or drop the dependency.`,
    };
  }
  if (repoName === target) {
    if (units.length > 1) {
      const names = units.map((u) => u.name).join(', ');
      return {
        error:
          `targets "${repoName}", which has ${units.length} services (${names}) — ` +
          `name one as "${repoName}/<service>"`,
      };
    }
    return { unit: units[0]! };
  }
  const svcName = target.slice(repoName.length + 1);
  const unit = units.find((u) => u.name === svcName);
  if (!unit) {
    const names = units.map((u) => u.name).join(', ');
    return { error: `targets unknown service "${svcName}" on "${repoName}" (has: ${names})` };
  }
  return { unit };
}

/** Names of repositories that declare no service. Never an error state. */
export function nonRunnableNames(manifest: Manifest): string[] {
  return Object.entries(manifest.repositories)
    .filter(([, repo]) => !isRunnable(repo))
    .map(([name]) => name);
}

/**
 * The single service for `name`, or undefined when the repository is unknown,
 * not runnable, or declares SEVERAL services (use `unitsOf` for those).
 */
export function serviceOf(manifest: Manifest, name: string): ServiceDef | undefined {
  const repo = manifest.repositories[name];
  const units = repo ? unitsOf(name, repo) : [];
  return units.length === 1 ? units[0]!.def : undefined;
}

/** Narrow a hot set (repository names) to the repositories that can be started. */
export function runnableSubset(manifest: Manifest, names: string[]): string[] {
  return names.filter((n) => {
    const repo = manifest.repositories[n];
    return repo !== undefined && isRunnable(repo);
  });
}

/** Units of the given repositories — the hot repository set expanded to processes. */
export function unitsOfRepos(manifest: Manifest, repoNames: readonly string[]): ServiceUnit[] {
  return repoNames.flatMap((n) => {
    const repo = manifest.repositories[n];
    return repo ? unitsOf(n, repo) : [];
  });
}
