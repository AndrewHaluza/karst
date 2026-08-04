import type { GateDef, ReviewConfig } from '../../manifest/types.js';
import type { ScriptProbe } from '../gates/probe.js';
import { resolveGates, type GateResolution, type ResolvedGate } from '../gates/resolve.js';
import { partitionDisabled, type StageGateResolution } from '../gates/disable.js';
import { REVIEW_PROBE_SCRIPTS } from '../gates/scripts.js';

/**
 * The declared gates targeting one repository, review's own config shape.
 *
 * Mirrors `uat/gates.ts`'s `declaredGatesFor` exactly: `review.repositories.<name>.gates`,
 * when present and non-empty, REPLACES the global `review.gates` list for that
 * repository — an override, not an addition. Absent (or explicitly empty,
 * which is indistinguishable from "no override" the same way an empty
 * top-level `review.gates` is indistinguishable from "no config" below) falls
 * back to the global list filtered by each gate's own optional `repo:` scope.
 *
 * The result feeds `resolveGates`'s `declared` parameter — this function owns
 * review's config shape (`review.gates` / `review.repositories.<name>.gates`),
 * resolution itself is shared with UAT in `workflow/gates/resolve.ts`.
 */
export function declaredReviewGatesFor(
  config: ReviewConfig | undefined,
  repoName: string | null,
): GateDef[] {
  const override =
    config !== undefined && repoName !== null ? config.repositories[repoName]?.gates : undefined;
  if (override !== undefined && override.length > 0) return override;

  return (config?.gates ?? []).filter(
    (g) => g.repo === undefined || repoName === null || g.repo === repoName,
  );
}

/** What a gate invocation IS, as a dedup key: the command, not the label on it. */
function identityKey(gate: ResolvedGate): string {
  return [gate.command, ...gate.args].join('\u0000');
}

/**
 * The gates for ONE target, which may back several manifest entries (a
 * repoPath shared by two `repositories:` entries collapses to one worktree,
 * `gates/targets.ts`'s `dedupeTargetsByRepoPath`). Mirrors `stages/uat.ts`'s
 * `resolveTargetGates` — kept here, rather than inline in `stages/review.ts`,
 * so review's config surface (`declaredReviewGatesFor`) and its resolution
 * stay paired in one module the way the manifest surface is documented.
 *
 * Every name is resolved and the results unioned by invocation identity (not
 * by gate name — two entries in one directory declaring the same command is
 * one question asked twice). A duplicate that is `required` anywhere stays
 * required. Unavailable is only the answer when NO name produced a gate — a
 * repository with one runnable entry can still be asked something; the first
 * unavailability wins, since one probe backs every name and they therefore
 * agree.
 *
 * `disabledNames` (optional, defaults to none) is the ticket's own cut,
 * applied ONCE over the deduplicated union — filtering earlier would report
 * the same disabled gate several times for a worktree backing several
 * repository entries.
 */
export function resolveReviewGates(
  probe: ScriptProbe,
  config: ReviewConfig | undefined,
  names: readonly string[],
  disabledNames: readonly string[] = [],
): StageGateResolution {
  const keys: (string | null)[] = names.length > 0 ? [...names] : [null];
  const byIdentity = new Map<string, ResolvedGate>();
  let unavailable: Extract<GateResolution, { kind: 'unavailable' }> | null = null;

  for (const name of keys) {
    const resolved = resolveGates(probe, declaredReviewGatesFor(config, name), REVIEW_PROBE_SCRIPTS);
    if (resolved.kind === 'unavailable') {
      unavailable ??= resolved;
      continue;
    }
    for (const gate of resolved.gates) {
      const key = identityKey(gate);
      const existing = byIdentity.get(key);
      if (existing === undefined) byIdentity.set(key, gate);
      else if (gate.required && !existing.required) {
        byIdentity.set(key, { ...existing, required: true });
      }
    }
  }

  const { kept, skipped } = partitionDisabled([...byIdentity.values()], disabledNames);
  if (kept.length > 0 || skipped.length > 0) return { kind: 'gates', gates: kept, skipped };
  // Zero gates, nothing disabled, and no unavailability is the malformed-
  // package.json case, which the caller (`stages/review.ts`) turns into a
  // named failure rather than a park.
  return unavailable ?? { kind: 'gates', gates: [], skipped: [] };
}
