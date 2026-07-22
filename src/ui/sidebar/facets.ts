import type { TicketWithStages } from '../../store/tickets.js';
import { ticketGlyph } from '../../model/ticketGlyph.js';

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

/**
 * The single facet a ticket belongs to (besides `all`), derived from its glyph:
 * amber→input (needs you), red→failed (blocked), blue→running (in progress),
 * green→done (shipped), gray→none (only matches `all`).
 *
 * Reads the glyph through `ticketGlyph` — the same call every other surface
 * makes — rather than re-deriving it from (status, agentState). Re-deriving is
 * how "Needs you" came to be unreachable here: a ticket parked at a confirm
 * stage is amber everywhere else, and this bucket did not know it.
 */
export function facetOf(t: TicketWithStages): DerivedFacetKey | null {
  const glyph = ticketGlyph(t);
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
 * A multi-select filter selection. The list stores which chips are lit, so
 * several status facets can be active at once — the fix for "filters can't show
 * multiple statuses at a time". The empty state is the sentinel `['all']`
 * (show everything); it is normalized, never a bare `[]`, so the UI always has a
 * lit chip. Ordered by `FACETS` for a stable render.
 */
export type FacetSelection = readonly FacetKey[];

/** The default (no-filter) selection: everything shown. */
export const DEFAULT_SELECTION: FacetSelection = ['all'];

/** Derived-state facet keys (the multi-selectable status chips), in display order. */
export const DERIVED_FACETS: readonly DerivedFacetKey[] = ['running', 'input', 'failed', 'done'];

const FACET_ORDER: Record<FacetKey, number> = {
  all: 0,
  running: 1,
  input: 2,
  failed: 3,
  done: 4,
  archived: 5,
};

function isDerived(key: FacetKey): key is DerivedFacetKey {
  return key !== 'all' && key !== 'archived';
}

/**
 * Normalize a raw selection into the canonical form the rest of the code relies
 * on: dedup, drop `all` when any real facet is present, order by `FACETS`, and
 * collapse the empty state to `['all']`. `archived` is a mutually-exclusive
 * lifecycle view — it sources a different list — so if it is present it wins and
 * every other key is dropped.
 */
export function normalizeSelection(keys: FacetSelection): FacetKey[] {
  const set = new Set(keys);
  if (set.has('archived')) return ['archived'];
  const derived = DERIVED_FACETS.filter((k) => set.has(k));
  if (derived.length === 0) return ['all'];
  return [...derived].sort((a, b) => FACET_ORDER[a] - FACET_ORDER[b]);
}

/**
 * Apply a chip click to the current selection and return the new (normalized)
 * one. This is the whole multi-select interaction, kept host-side so the webview
 * only reports WHICH chip was clicked (a trust boundary — one validated key):
 *
 * - `all`      → reset to `['all']` (clears every status filter).
 * - `archived` → toggle the exclusive archived view on/off (off ⇒ back to All).
 * - a status   → toggle it in/out of the union; emptying the union ⇒ `['all']`.
 *   Clicking a status while Archived is active leaves Archived for that status.
 */
export function toggleFacet(current: FacetSelection, key: FacetKey): FacetKey[] {
  if (key === 'all') return ['all'];
  if (key === 'archived') {
    return current.length === 1 && current[0] === 'archived' ? ['all'] : ['archived'];
  }
  // A status chip: start from the current status union (dropping all/archived),
  // then toggle this one.
  const set = new Set(current.filter(isDerived));
  if (set.has(key)) set.delete(key);
  else set.add(key);
  return normalizeSelection([...set]);
}

/**
 * Whether a ticket matches a normalized selection. `all` (the empty union)
 * matches everything; a status union matches when the ticket's own facet is in
 * it; `archived` is a source-level view (the provider swaps to the archived
 * list) so it never matches an active ticket here.
 */
export function matchesSelection(t: TicketWithStages, selection: FacetSelection): boolean {
  if (selection.includes('archived')) return false;
  const derived = selection.filter(isDerived);
  if (derived.length === 0) return true; // ['all']
  const f = facetOf(t);
  return f !== null && derived.includes(f);
}

/**
 * Filter an (active) ticket list to those matching the selection (order
 * preserved). `archived` isn't a predicate — the provider sources archived
 * tickets directly — so it yields an empty list here.
 */
export function filterBySelection(
  tickets: readonly TicketWithStages[],
  selection: FacetSelection,
): TicketWithStages[] {
  if (selection.includes('archived')) return [];
  const derived = selection.filter(isDerived);
  if (derived.length === 0) return [...tickets];
  return tickets.filter((t) => matchesSelection(t, selection));
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
