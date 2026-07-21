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

/** A repository that declares a service — i.e. one that can actually be run. */
export type RunnableRepo = RepositoryDef & { service: ServiceDef };

/** Type guard: does this repository declare a runnable service? */
export function isRunnable(repo: RepositoryDef): repo is RunnableRepo {
  return repo.service !== undefined;
}

/**
 * Every runnable repository, as `[name, repo]` pairs with `service` narrowed.
 * Use this instead of `Object.entries(manifest.repositories)` anywhere the loop
 * body needs runtime fields.
 */
export function runnableEntries(manifest: Manifest): Array<[string, RunnableRepo]> {
  return Object.entries(manifest.repositories).filter(
    (entry): entry is [string, RunnableRepo] => isRunnable(entry[1]),
  );
}

/** Names of repositories that declare no service. Never an error state. */
export function nonRunnableNames(manifest: Manifest): string[] {
  return Object.entries(manifest.repositories)
    .filter(([, repo]) => !isRunnable(repo))
    .map(([name]) => name);
}

/**
 * The service for `name`, or undefined when the repository is unknown OR known
 * but not runnable. Callers that must distinguish those two cases should look
 * `manifest.repositories[name]` up themselves — this helper deliberately
 * collapses them for the common "is there something to start here?" question.
 */
export function serviceOf(manifest: Manifest, name: string): ServiceDef | undefined {
  return manifest.repositories[name]?.service;
}

/** Narrow a hot set to the repositories that can actually be started. */
export function runnableSubset(manifest: Manifest, names: string[]): string[] {
  return names.filter((n) => {
    const repo = manifest.repositories[n];
    return repo !== undefined && isRunnable(repo);
  });
}
