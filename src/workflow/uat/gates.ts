import type { UatConfig, UatGateDef } from '../../manifest/types.js';

/**
 * The scripts karst looks for when `uat.gates` is absent, cheapest first.
 *
 * Ordering is a cost argument: `test` (seconds) → integration (tens of seconds) →
 * e2e (minutes), so the cheapest signal fails fastest. Most repositories need no
 * configuration at all, which is the whole point — an explicit list always wins.
 *
 * This is UAT's own value for `resolveGates`'s `probeList` parameter
 * (`workflow/gates/resolve.ts`) — review passes its own list there.
 */
export const PROBE_SCRIPTS: readonly string[] = [
  'test',
  'test:integration',
  'e2e',
  'test:e2e',
  'cypress',
  'playwright',
];

/**
 * The declared gates targeting one repository.
 *
 * `uat.repositories.<name>.gates`, when present and non-empty, REPLACES the
 * global `uat.gates` list for that repository — it is an override, not an
 * addition. Absent (or explicitly empty, which is indistinguishable from "no
 * override" the same way an empty top-level `uat.gates` is indistinguishable
 * from "no config" below), falls back to the global list filtered by each
 * gate's own optional `repo:` scope.
 *
 * The result feeds `resolveGates`'s `declared` parameter — this function owns
 * UAT's config shape (`uat.gates` / `uat.repositories.<name>.gates`), resolution
 * itself is shared with review in `workflow/gates/resolve.ts`.
 */
export function declaredGatesFor(
  config: UatConfig | undefined,
  repoName: string | null,
): UatGateDef[] {
  const override =
    config !== undefined && repoName !== null ? config.repositories[repoName]?.gates : undefined;
  if (override !== undefined && override.length > 0) return override;

  return (config?.gates ?? []).filter(
    (g) => g.repo === undefined || repoName === null || g.repo === repoName,
  );
}
