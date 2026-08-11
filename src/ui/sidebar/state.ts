import type { Store } from '../../store/db.js';
import type { AgentProvider } from '../../manifest/types.js';
import { listTickets, listArchivedTickets } from '../../store/tickets.js';
import {
  listServersByTicket,
  listWorktreesByTicket,
  listPrsByTicket,
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

/** The PR fields the sidebar's meta line reads — a narrowed `PrView`. */
export interface SidebarPr {
  repo: string;
  number: number | null;
  url: string | null;
  status: string | null;
}

/** One ticket row: the collapsed node fields plus its expanded-body detail. */
export interface TicketRow extends TicketNode {
  /** Running servers backing the expanded meta line. */
  servers: ServerView[];
  /** Worktrees backing the expanded meta line. */
  worktrees: SidebarWorktree[];
  /**
   * Open PRs backing the expanded meta line (rendered as "PR #<n>").
   *
   * Deliberately narrowed to the identifying fields: this list is pushed for
   * EVERY ticket on the board, so carrying the dashboard's PR metadata (comment
   * bodies included) would put a whole review thread per ticket on the wire for a
   * line that only prints numbers.
   */
  prs: SidebarPr[];
  /**
   * True when the ticket's dashboard/edit/diffs view is the window's ACTIVE
   * view right now — the row the sidebar highlights. Window UI context, never
   * a ticket fact, which is why it rides the row rather than the node.
   */
  isActive: boolean;
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
    /** Manifest-level agent core; decides whether a captured session is resumable. */
    defaultProvider?: AgentProvider;
    /**
     * The window's project (§ projects / multi-window). Both lists are scoped to
     * it — including the counts, or the chip badges would advertise tickets the
     * user can't see. Undefined only before a project is bound.
     */
    projectId?: number;
    /**
     * The ticket whose dashboard/edit/diffs view is currently active in this
     * window, if any; its row is highlighted. Null/undefined → no highlight.
     */
    activeTicketId?: number | null;
  },
  pathContext?: PathContext,
): SidebarState {
  const scope = { projectId: opts.projectId };
  const active = listTickets(store, scope);
  const archived = listArchivedTickets(store, scope);

  const facets = normalizeSelection(opts.facets);
  const source = facets.includes('archived') ? archived : filterBySelection(active, facets);
  const visible = filterTickets(source, opts.filter);

  // Every ticket in the project, active + archived, so a follow-up row can
  // resolve its parent's key even when the parent sits in a facet the user
  // isn't currently viewing (e.g. the parent was archived after the child
  // was created).
  const parentKeys = new Map<number, string>();
  for (const t of [...active, ...archived]) {
    if (t.key !== null) parentKeys.set(t.id, t.key);
  }

  const rows: TicketRow[] = buildTicketNodes(
    visible,
    opts.labelTemplate,
    opts.defaultProvider,
    parentKeys,
  ).map((node) => ({
    ...node,
    isActive: node.ticketId === (opts.activeTicketId ?? null),
    servers: listServersByTicket(store, node.ticketId),
    worktrees: listWorktreesByTicket(store, node.ticketId).map((w) => ({
      ...w,
      repoDisplay: repoDisplayPath(w.repo, pathContext),
    })),
    prs: listPrsByTicket(store, node.ticketId).map(
      (p): SidebarPr => ({ repo: p.repo, number: p.number, url: p.url, status: p.status }),
    ),
  }));

  return {
    facets,
    filter: opts.filter,
    counts: facetCounts(active, archived.length),
    rows,
  };
}
