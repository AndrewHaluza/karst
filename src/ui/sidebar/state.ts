import type { Store } from '../../store/db.js';
import type { AgentProvider } from '../../manifest/types.js';
import { listTickets, listArchivedTickets, type TicketWithStages } from '../../store/tickets.js';
import {
  listServersByTicket,
  listWorktreesByTicket,
  listPrsByTicket,
  type ServerView,
  type WorktreeView,
} from '../../store/dashboard.js';
import {
  buildTicketNodes,
  filterTickets,
  isDoneTicket,
  completedAt,
  type TicketNode,
} from './items.js';
import {
  filterBySelection,
  facetCounts,
  normalizeSelection,
  type FacetKey,
  type FacetSelection,
} from './facets.js';
import { repoDisplayPath, type PathContext } from '../worktreePath.js';
import { buildPeek, type TicketPeek } from './peek.js';
import { listGateRuns } from '../../store/gateRuns.js';
import { mergeGateState } from '../../workflow/mergeGate.js';

/** A worktree row enriched with its display path (honors `worktreePathDisplay`). */
export interface SidebarWorktree extends WorktreeView {
  /** `repo` rendered per the manifest's path-display mode (absolute or relative). */
  repoDisplay: string;
}

/**
 * How many completed tickets the Recently Done section holds before the rest
 * falls behind the Older Completed control. The ONE constant — a second copy
 * anywhere would let the recent list and the history count disagree.
 */
export const RECENT_DONE_LIMIT = 3;

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
  /**
   * The expanded row's mini-dashboard summary (peek.ts) — the strongest
   * current-state line, one small context line, and the suggested next step,
   * computed host-side so the standalone webview never phrases domain state.
   */
  peek: TicketPeek;
}

/**
 * The three sections of the default All view. `current` preserves the canonical
 * ticket order verbatim — completing a ticket REMOVES it from this list and
 * must never reorder what remains; the two completed sections sort by
 * completion time, newest first, and are projections of the same ticket
 * source, never separate stores.
 */
export interface SidebarSections {
  /** Every non-Done, non-Archived ticket, in canonical order. */
  current: TicketRow[];
  /** The `RECENT_DONE_LIMIT` most recently completed tickets, newest first. */
  recentlyDone: TicketRow[];
  /** Every other completed ticket, newest first (behind the history control). */
  olderDone: TicketRow[];
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
  /**
   * The All view's three sections. Empty (all lists) for every other facet —
   * the webview picks one of `sections` / `done` / `rows` from `facets`, and
   * only that one is populated, so the wire carries exactly what renders.
   */
  sections: SidebarSections;
  /**
   * The Done facet: the FULL completed list, newest first, no history control —
   * Recently Done and Older Completed are conceptually merged for this mode.
   */
  done: TicketRow[];
  /**
   * Every other view (archived facet, derived-status unions): the flat filtered
   * list, exactly as before the sectioning.
   */
  rows: TicketRow[];
}

/**
 * Newest completion first; a ticket with NO completion timestamp sorts LAST
 * (an unknown time must not read as the most recent completion). Ties break by
 * id descending so the order is deterministic.
 */
function byCompletedAtDesc(a: TicketWithStages, b: TicketWithStages): number {
  const ka = completedAt(a);
  const kb = completedAt(b);
  if (ka === kb) return b.id - a.id;
  if (ka === null) return 1;
  if (kb === null) return -1;
  return ka < kb ? 1 : -1;
}

/**
 * Build the sidebar state for a facet + filter. The `archived` facet sources its
 * own list; every other facet filters the active (non-archived) list by facet
 * then by search text. The All view partitions that list into Current (canonical
 * order) and the two completed sections (completion time, newest first), each
 * filtered by the search query AFTER the recency partition — so a query can
 * surface a ticket in Older Completed that the recent-3 never contained, and
 * the webview can reveal it. Rows reuse `buildTicketNodes` (single glyph/label
 * source) and are enriched with each ticket's running servers + worktrees for
 * the expanded body. Counts always reflect the full active list + archived
 * total, so the chip badges are stable regardless of the current filter.
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
  const query = opts.filter;

  // Every ticket in the project, active + archived, so a follow-up row can
  // resolve its parent's key even when the parent sits in a facet the user
  // isn't currently viewing (e.g. the parent was archived after the child
  // was created).
  const parentKeys = new Map<number, string>();
  for (const t of [...active, ...archived]) {
    if (t.key !== null) parentKeys.set(t.id, t.key);
  }

  const enrich = (tickets: readonly TicketWithStages[]): TicketRow[] => {
    const nodes = buildTicketNodes(tickets, opts.labelTemplate, opts.defaultProvider, parentKeys);
    return tickets.map((t, i) => {
      const node = nodes[i]!;
      const worktrees = listWorktreesByTicket(store, node.ticketId).map((w) => ({
        ...w,
        repoDisplay: repoDisplayPath(w.repo, pathContext),
      }));
      const servers = listServersByTicket(store, node.ticketId);
      const prs = listPrsByTicket(store, node.ticketId).map(
        (p): SidebarPr => ({ repo: p.repo, number: p.number, url: p.url, status: p.status }),
      );
      return {
        ...node,
        isActive: node.ticketId === (opts.activeTicketId ?? null),
        servers,
        worktrees,
        prs,
        // The mini-dashboard summary. The extra evidence reads are SCOPED to the
        // stage that needs them — the gate ledger only for a gate stage, the
        // merge gate only for ship — so the board never pays per-ticket for
        // state it will not show.
        peek: buildPeek({
          stageCurrent: t.stageCurrent,
          current: t.stages.find((s) => s.stageKey === t.stageCurrent) ?? null,
          agentState: t.agentState,
          sessionAction: node.sessionAction,
          worktrees,
          servers,
          gateRuns:
            t.stageCurrent === 'uat' || t.stageCurrent === 'review'
              ? listGateRuns(store, t.id)
              : [],
          mergeGate: t.stageCurrent === 'ship' ? mergeGateState(store, t.id) : null,
        }),
      };
    });
  };

  const counts = facetCounts(active, archived.length);
  const base = { facets, filter: query, counts };

  const isAll = facets.length === 1 && facets[0] === 'all';
  const isDone = facets.length === 1 && facets[0] === 'done';

  if (isAll) {
    // Done tickets are split by recency BEFORE the search filter, so the
    // recent-3 is "the three most recently completed tickets" regardless of
    // query, and a query can only ever surface older tickets in olderDone.
    const done = active.filter(isDoneTicket).sort(byCompletedAtDesc);
    const recent = done.slice(0, RECENT_DONE_LIMIT);
    const older = done.slice(RECENT_DONE_LIMIT);
    return {
      ...base,
      sections: {
        current: enrich(filterTickets(active.filter((t) => !isDoneTicket(t)), query)),
        recentlyDone: enrich(filterTickets(recent, query)),
        olderDone: enrich(filterTickets(older, query)),
      },
      done: [],
      rows: [],
    };
  }

  if (isDone) {
    return {
      ...base,
      sections: { current: [], recentlyDone: [], olderDone: [] },
      done: enrich(filterTickets(active.filter(isDoneTicket).sort(byCompletedAtDesc), query)),
      rows: [],
    };
  }

  const source = facets.includes('archived') ? archived : filterBySelection(active, facets);
  return {
    ...base,
    sections: { current: [], recentlyDone: [], olderDone: [] },
    done: [],
    rows: enrich(filterTickets(source, query)),
  };
}
