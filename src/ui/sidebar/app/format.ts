/**
 * Pure view helpers for the sidebar app: labels, the relative-time formatter,
 * the expanded row's meta line and the sub-tree visibility filter. No React, no
 * DOM — unit-testable on their own.
 */
import type { FacetKey } from '../facets.js';
import type { QueueRowView, SidebarState, TicketRow } from '../state.js';
import { GLYPH_WORD, type Glyph } from '../../../model/glyph.js';
import type { StatusKind } from '../../shared/Status.js';

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
 * status meaning, "done" to "passed". `label` is the shared `GLYPH_WORD`
 * (SB-13), so the facet and the glyph name one state.
 */
export const FACET_META: ReadonlyArray<{ key: FacetKey; label: string; dotVariant: string | null }> = [
  { key: 'all', label: 'All', dotVariant: null },
  { key: 'running', label: GLYPH_WORD.blue, dotVariant: 'running' },
  { key: 'input', label: GLYPH_WORD.amber, dotVariant: 'attention' },
  { key: 'failed', label: GLYPH_WORD.red, dotVariant: 'failed' },
  { key: 'done', label: GLYPH_WORD.green, dotVariant: 'passed' },
  { key: 'archived', label: 'Archived', dotVariant: null },
];

/** The autostart sub-task state word: "Queued" / "Starting". */
export const AUTOSTART_WORD: Readonly<Record<string, string>> = { queued: 'Queued', starting: 'Starting' };

/**
 * The status marker each glyph paints (SB-1). One shape per state, so the hue
 * reinforces the shape instead of carrying it alone (UI-R28, UI-R28b).
 */
export const GLYPH_STATUS: Readonly<Record<Glyph, StatusKind>> = {
  gray: 'pending',
  blue: 'running',
  amber: 'attention',
  green: 'passed',
  red: 'failed',
};

/** The empty snapshot shown before the first host push (and for a pre-upgrade restore). */
export const EMPTY_STATE: SidebarState = {
  facets: ['all'],
  filter: '',
  counts: { all: 0, running: 0, input: 0, failed: 0, done: 0, archived: 0 },
  sections: { current: [], awaitingReview: [], recentlyDone: [], olderDone: [] },
  done: [],
  rows: [],
  queue: { rows: [], drafts: 0, sessions: 0, tickets: 0 },
  planning: [],
  activity: { rows: [], unread: 0, total: 0, hasMore: false },
  unlinkedCloudSessions: [],
};

/** The fields every Queue row has had since the pane shipped; a snapshot always carries them. */
type QueueRowIdentity = 'position' | 'kind' | 'id' | 'idLabel' | 'title';

/**
 * A value for every other Queue row field. The type names every field outside the
 * identity, so a new field fails typecheck here until it has a default.
 */
const QUEUE_ROW_DEFAULTS: Omit<QueueRowView, QueueRowIdentity> = {
  sessionLabel: null,
  sessionTitle: null,
  level: 'normal',
  inheritedFrom: null,
  waitsOn: [],
  unblocks: [],
  waitsOnRefs: [],
  inheritedRef: null,
  cycleRef: null,
  cycle: false,
  why: '',
  whyKind: 'none',
  ownLevel: null,
  prioritySource: null,
  providerPriority: null,
  providerLabel: null,
};

/**
 * Fill the fields a snapshot from an older build does not have. The webview
 * restores its last snapshot on load, and one missing field the view reads
 * throws in render and blanks the whole sidebar (#1126, #1133).
 */
export function withStateDefaults(prev: SidebarState | undefined): SidebarState {
  if (!prev) return EMPTY_STATE;
  const merged = { ...EMPTY_STATE, ...prev };
  const queue = { ...EMPTY_STATE.queue, ...merged.queue };
  const rows = Array.isArray(queue.rows) ? queue.rows : [];
  // A snapshot saved before the Activity pane has no `activity`; a corrupt one has no row list.
  const activity = { ...EMPTY_STATE.activity, ...merged.activity };
  return {
    ...merged,
    queue: { ...queue, rows: rows.map((r) => ({ ...QUEUE_ROW_DEFAULTS, ...r })) },
    activity: { ...activity, rows: Array.isArray(activity.rows) ? activity.rows : [] },
  };
}

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

/**
 * The headline age: `for 2h` for a running stage, `6m ago` for a finished one.
 * The host sends ISO times; this runs in the webview so a stale snapshot never freezes the text.
 */
export function sinceText(since: { at: string; kind: 'for' | 'ago' } | null | undefined, now: number = Date.now()): string {
  if (!since) return '';
  if (since.kind === 'ago') return relTime(since.at, now);
  const t = Date.parse(since.at);
  if (Number.isNaN(t)) return '';
  const m = Math.floor(Math.max(0, now - t) / 60_000);
  if (m < 1) return 'for <1m';
  if (m < 60) return `for ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `for ${h}h`;
  return `for ${Math.floor(h / 24)}d`;
}

/** The agent line's last-activity text: `active 4m ago`. Empty before the first hook. */
export function activeText(at: string | null | undefined, now: number = Date.now()): string {
  const rel = relTime(at, now);
  return rel ? `active ${rel}` : '';
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

/** The "where" fact line: repos joined by " + ", then the running ports. Empty when neither exists. */
export function whereLine(row: TicketRow): string {
  const repos = (row.worktrees || []).map((w) => w.repoDisplay || w.repo).filter(Boolean);
  const ports = (row.servers || []).map((s) => s.port).filter(Boolean);
  const tokens: string[] = [];
  if (repos.length) tokens.push(repos.join(' + '));
  if (ports.length) tokens.push(ports.map((p) => ':' + p).join(', '));
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
