import type { Store } from '../../store/db.js';
import { listTickets, listArchivedTickets } from '../../store/tickets.js';
import {
  listServersByTicket,
  listWorktreesByTicket,
  type ServerView,
  type WorktreeView,
} from '../../store/dashboard.js';
import { buildTicketNodes, filterTickets, type TicketNode } from './items.js';
import {
  filterBySelection,
  facetCounts,
  normalizeSelection,
  type FacetKey,
  type FacetSelection,
} from './facets.js';
import { repoDisplayPath, type PathContext } from '../worktreePath.js';

/** A worktree row enriched with its display path (honors `worktreePathDisplay`). */
export interface SidebarWorktree extends WorktreeView {
  /** `repo` rendered per the manifest's path-display mode (absolute or relative). */
  repoDisplay: string;
}

/**
 * Serializable state for the sidebar ticket-list webview (§14 redesign). The view
 * replaced the native tree with an HTML surface; this is the plain snapshot the
 * host pushes on every refresh/filter/facet change. Everything crosses the
 * postMessage boundary, so no class instances — only data.
 */

/** One ticket row: the collapsed node fields plus its expanded-body detail. */
export interface TicketRow extends TicketNode {
  /** Running servers backing the expanded meta line. */
  servers: ServerView[];
  /** Worktrees backing the expanded meta line. */
  worktrees: SidebarWorktree[];
}

export interface SidebarState {
  /**
   * Active facet selection — the lit chips. Multi-select: several status facets
   * can be on at once (their union). `['all']` by default; `['archived']` is the
   * exclusive soft-deleted view. Always normalized (never a bare `[]`).
   */
  facets: FacetKey[];
  /** Case-insensitive key/title search filter (empty = no filter). */
  filter: string;
  /** Per-facet counts for the chip badges (archived counted separately). */
  counts: Record<FacetKey, number>;
  rows: TicketRow[];
}

/**
 * Build the sidebar state for a facet + filter. The `archived` facet sources its
 * own list; every other facet filters the active (non-archived) list by facet
 * then by search text. Rows reuse `buildTicketNodes` (single glyph/label source)
 * and are enriched with each ticket's running servers + worktrees for the
 * expanded body. Counts always reflect the full active list + archived total, so
 * the chip badges are stable regardless of the current filter.
 */
export function buildSidebarState(
  store: Store,
  opts: {
    facets: FacetSelection;
    filter: string;
    labelTemplate?: string;
    /**
     * The window's project (§ projects / multi-window). Both lists are scoped to
     * it — including the counts, or the chip badges would advertise tickets the
     * user can't see. Undefined only before a project is bound.
     */
    projectId?: number;
  },
  pathContext?: PathContext,
): SidebarState {
  const scope = { projectId: opts.projectId };
  const active = listTickets(store, scope);
  const archived = listArchivedTickets(store, scope);

  const facets = normalizeSelection(opts.facets);
  const source = facets.includes('archived') ? archived : filterBySelection(active, facets);
  const visible = filterTickets(source, opts.filter);

  const rows: TicketRow[] = buildTicketNodes(visible, opts.labelTemplate).map((node) => ({
    ...node,
    servers: listServersByTicket(store, node.ticketId),
    worktrees: listWorktreesByTicket(store, node.ticketId).map((w) => ({
      ...w,
      repoDisplay: repoDisplayPath(w.repo, pathContext),
    })),
  }));

  return {
    facets,
    filter: opts.filter,
    counts: facetCounts(active, archived.length),
    rows,
  };
}
