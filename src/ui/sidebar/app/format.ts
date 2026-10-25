/**
 * Pure view helpers for the sidebar app: labels, the relative-time formatter,
 * the expanded row's meta line and the sub-tree visibility filter. No React, no
 * DOM — unit-testable on their own.
 */
import type { FacetKey } from '../facets.js';
import type { SidebarState, TicketRow } from '../state.js';

/**
 * The deepest indent painted, mirroring `MAX_SUBTASK_INDENT` in
 * `ui/sidebar/items.ts` (which sets it to the writer's `MAX_SUBTASK_DEPTH`).
 * The host clamps `subtaskDepth` to this, so this constant only bounds the CSS
 * class; `format.test.ts` pins it to the writer's depth.
 */
export const MAX_SUBTASK_INDENT = 4;

/**
 * `dotVariant` names a `.k-dot--<variant>` suffix (model/designComponents), not
 * the facet's own key — "input" (needs you) maps to the shared "attention"
 * status meaning, "done" to "passed".
 */
export const FACET_META: ReadonlyArray<{ key: FacetKey; label: string; dotVariant: string | null }> = [
  { key: 'all', label: 'All', dotVariant: null },
  { key: 'running', label: 'In progress', dotVariant: 'running' },
  { key: 'input', label: 'Needs you', dotVariant: 'attention' },
  { key: 'failed', label: 'Blocked', dotVariant: 'failed' },
  { key: 'done', label: 'Done', dotVariant: 'passed' },
  { key: 'archived', label: 'Archived', dotVariant: null },
];

/** Status word for the glyph's role="img" aria-label — colour is never the only carrier (UI-R28). */
export const GLYPH_WORD: Readonly<Record<string, string>> = {
  gray: 'Pending',
  blue: 'Running',
  amber: 'Needs you',
  green: 'Done',
  red: 'Failed',
};

export const AUTOSTART_WORD: Readonly<Record<string, string>> = { queued: 'Queued', starting: 'Starting' };

/** The empty snapshot shown before the first host push (and for a pre-upgrade restore). */
export const EMPTY_STATE: SidebarState = {
  facets: ['all'],
  filter: '',
  counts: { all: 0, running: 0, input: 0, failed: 0, done: 0, archived: 0 },
  sections: { current: [], awaitingReview: [], recentlyDone: [], olderDone: [] },
  done: [],
  rows: [],
  planning: [],
};

/**
 * Compact "4m ago" / "2h ago" from an ISO timestamp, against the viewer's clock
 * (the host stores UTC; formatting here keeps the model host-clock-free).
 */
export function relTime(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** The expanded row's meta line: model, repos, ports, PRs — empty tokens omitted. */
export function metaLine(row: TicketRow): string {
  const ports = (row.servers || []).map((s) => s.port).filter(Boolean);
  const repos = (row.worktrees || []).map((w) => w.repoDisplay || w.repo).filter(Boolean);
  const prs = (row.prs || []).map((p) => p.number).filter((n) => n != null);
  const tokens: string[] = [];
  if (row.model) tokens.push(row.model);
  if (repos.length) tokens.push(repos.join('+'));
  if (ports.length) tokens.push(ports.map((p) => ':' + p).join(', '));
  if (prs.length) tokens.push(prs.map((n) => 'PR #' + n).join(', '));
  return tokens.join(' · ');
}

/**
 * Rows to RENDER given the collapsed sub-trees: a row is dropped when a strict
 * ancestor is collapsed. Mirrors `visibleTicketRows` in ui/sidebar/items.ts (the
 * unit-tested spec) over the host-stamped `subtaskDepth`.
 */
export function visibleRows(rows: readonly TicketRow[], collapsed: ReadonlySet<number>): readonly TicketRow[] {
  if (collapsed.size === 0) return rows;
  const out: TicketRow[] = [];
  const ancestors: number[] = [];
  for (const row of rows) {
    const depth = row.subtaskDepth || 0;
    ancestors.length = depth;
    ancestors[depth] = row.ticketId;
    let hidden = false;
    for (let d = 0; d < depth; d += 1) {
      const a = ancestors[d];
      if (a !== undefined && collapsed.has(a)) {
        hidden = true;
        break;
      }
    }
    if (!hidden) out.push(row);
  }
  return out;
}

/** Every ticket row of a snapshot, across the flat list, the Done list and the four sections. */
export function allRows(state: SidebarState): TicketRow[] {
  const secs = state.sections;
  return [
    ...(state.rows || []),
    ...(state.done || []),
    ...(secs?.current || []),
    ...(secs?.awaitingReview || []),
    ...(secs?.recentlyDone || []),
    ...(secs?.olderDone || []),
  ];
}

/** A row's data by id across every section/facet the list renders (the ⋯ menu only carries the id). */
export function findRow(state: SidebarState, id: number): TicketRow | null {
  return allRows(state).find((r) => r.ticketId === id) ?? null;
}
