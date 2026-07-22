import type { TicketWithStages } from '../../store/tickets.js';
import { glyphFor } from '../../model/glyph.js';
import type { StageStatus, AgentState } from '../../model/types.js';

/**
 * Derived state facets for the ticket list (§14 redesign). A ticket has no
 * explicit status column; its "state" is derived from the current stage status
 * and agent liveness — the same signals that drive the glyph — so the facet a
 * ticket falls into always agrees with the colored dot beside it.
 *
 * `all` is the default and shows every non-archived ticket. `archived` is
 * handled by the store's include/exclude filter (Phase 3), not a predicate here.
 */
export type FacetKey = 'all' | 'running' | 'input' | 'failed' | 'done' | 'archived';

/** State facets derived from stage/agent. Excludes `archived` (a lifecycle view). */
export type DerivedFacetKey = Exclude<FacetKey, 'all' | 'archived'>;

export interface Facet {
  key: FacetKey;
  label: string;
}

/**
 * Ordered facet list for the filter UI. Order = display order. `archived` is a
 * lifecycle view (soft-deleted tickets) rather than a derived-state bucket, so
 * it sits last, after the state facets.
 */
export const FACETS: readonly Facet[] = [
  { key: 'all', label: 'All' },
  { key: 'running', label: 'In progress' },
  { key: 'input', label: 'Needs you' },
  { key: 'failed', label: 'Blocked' },
  { key: 'done', label: 'Done' },
  { key: 'archived', label: 'Archived' },
];

/** Status of the ticket's current stage, defaulting to pending when unknown. */
function currentStageStatus(t: TicketWithStages): StageStatus {
  const cur = t.stages.find((s) => s.stageKey === t.stageCurrent);
  return cur?.status ?? 'pending';
}

/**
 * The single facet a ticket belongs to (besides `all`), derived from its glyph:
 * amber→input (needs you), red→failed (blocked), blue→running (in progress),
 * green→done (shipped), gray→none (only matches `all`).
 */
export function facetOf(t: TicketWithStages): DerivedFacetKey | null {
  const glyph = glyphFor(currentStageStatus(t), (t.agentState ?? 'none') as AgentState);
  switch (glyph) {
    case 'amber':
      return 'input';
    case 'red':
      return 'failed';
    case 'blue':
      return 'running';
    case 'green':
      return 'done';
    default:
      return null; // gray: pending/idle — only in `all`
  }
}

/**
 * Whether a ticket matches a facet. `all` matches everything; `archived` is a
 * source-level view (the provider swaps to the archived list) so it's not a
 * predicate here and always returns false.
 */
export function matchesFacet(t: TicketWithStages, facet: FacetKey): boolean {
  if (facet === 'all') return true;
  if (facet === 'archived') return false;
  return facetOf(t) === facet;
}

/**
 * Filter an (active) ticket list to those matching the facet (order preserved).
 * `archived` isn't a predicate — the provider sources archived tickets directly —
 * so it yields an empty list here.
 */
export function filterByFacet(
  tickets: readonly TicketWithStages[],
  facet: FacetKey,
): TicketWithStages[] {
  if (facet === 'all') return [...tickets];
  if (facet === 'archived') return [];
  return tickets.filter((t) => matchesFacet(t, facet));
}

/**
 * Count of tickets in each facet, for the filter UI badges. `active` are the
 * non-archived tickets (drive the derived facets); `archivedCount` is supplied
 * separately since archived tickets live outside the active list.
 */
export function facetCounts(
  active: readonly TicketWithStages[],
  archivedCount = 0,
): Record<FacetKey, number> {
  const counts: Record<FacetKey, number> = {
    all: active.length,
    running: 0,
    input: 0,
    failed: 0,
    done: 0,
    archived: archivedCount,
  };
  for (const t of active) {
    const f = facetOf(t);
    if (f) counts[f] += 1;
  }
  return counts;
}
