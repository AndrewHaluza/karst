/**
 * The baseline review's pure view model (@arch:BASELINE-REVIEW): the host rows normalised, grouped by screenshot name,
 * counted and filtered. Grouping is view-only; the host row shape is unchanged and every decision message still names
 * only the block id and entry indices.
 */
import type { BaselineReviewRow } from '../baselineRows.js';

export const STATUS_WORD: Readonly<Record<string, string>> = { added: 'new file', modified: 'modified', deleted: 'deleted' };
export const DECISION_GLYPH: Readonly<Record<string, 'wait' | 'pass' | 'fail'>> = { pending: 'wait', approved: 'pass', rejected: 'fail' };
export const DECISION_WORD: Readonly<Record<string, string>> = { pending: 'Needs review', approved: 'Approved', rejected: 'Rejected' };

/** The visual-test theme folders: a label under one of them groups by the rest of its path. */
export const THEME_FOLDERS: readonly string[] = ['dark', 'dark-grayscale', 'dark-reduced-motion', 'light', 'hc'];

export type Decision = 'pending' | 'approved' | 'rejected';
export type Status = 'added' | 'modified' | 'deleted';
export type View = 'old' | 'new' | 'diff' | 'sbs';
export type Filter = 'pending' | 'rejected' | 'approved' | 'all';

export interface Row {
  readonly index: number;
  readonly path: string;
  readonly status: Status;
  readonly decision: Decision;
  readonly label: string;
  readonly reason: string;
  readonly oldSrc: string;
  readonly newSrc: string;
}

export interface Group {
  readonly name: string;
  readonly decision: Decision;
  readonly rows: readonly Row[];
}

export type Counts = Readonly<Record<Filter, number>>;

/** Index to an integer and the enums to their allowlists, so nothing but a known word and digits reaches the ids and attributes. */
export const normaliseRow = (r: BaselineReviewRow): Row => ({
  index: Number(r.index) | 0,
  path: String(r.path || r.label || ''),
  status: Object.hasOwn(STATUS_WORD, r.status) ? r.status : 'modified',
  decision: Object.hasOwn(DECISION_WORD, r.decision) ? r.decision : 'pending',
  label: String(r.label || ''),
  reason: String(r.reason || ''),
  oldSrc: r.oldSrc ? String(r.oldSrc) : '',
  newSrc: r.newSrc ? String(r.newSrc) : '',
});

export const normaliseRows = (rows: readonly BaselineReviewRow[]): Row[] => rows.map(normaliseRow);

/** The theme folder a label sits in, or '' when its first segment is not a theme. */
export function themeOf(label: string): string {
  const [first = '', ...rest] = label.split('/');
  return rest.length > 0 && THEME_FOLDERS.includes(first) ? first : '';
}

export function groupKey(label: string): string {
  const theme = themeOf(label);
  return theme ? label.slice(theme.length + 1) : label;
}

const groupDecision = (rows: readonly Row[]): Decision =>
  rows.some((r) => r.decision === 'rejected') ? 'rejected' : rows.some((r) => r.decision === 'pending') ? 'pending' : 'approved';

/** One group per screenshot name, in the order each name first appears. */
export function buildGroups(rows: readonly Row[]): Group[] {
  const byName = new Map<string, Row[]>();
  for (const r of rows) {
    const key = groupKey(r.label);
    byName.set(key, [...(byName.get(key) ?? []), r]);
  }
  return [...byName].map(([name, members]) => ({ name, decision: groupDecision(members), rows: members }));
}

export function countRows(rows: readonly Row[]): Counts {
  const n = (d: Decision): number => rows.filter((r) => r.decision === d).length;
  return { pending: n('pending'), rejected: n('rejected'), approved: n('approved'), all: rows.length };
}

export const filterRows = (rows: readonly Row[], filter: Filter): Row[] => (filter === 'all' ? [...rows] : rows.filter((r) => r.decision === filter));

/** Needs review, or All when nothing is waiting. */
export const defaultFilter = (counts: Counts): Filter => (counts.pending > 0 ? 'pending' : 'all');

/** Difference for a modified file, New for an added one, Old for a deleted one. */
export const defaultView = (status: Status): View => (status === 'added' ? 'new' : status === 'deleted' ? 'old' : 'diff');

/** The next pending entry after `from` in list order, wrapping, skipping the `skip` indices; null when no other entry is pending. */
export function nextOpen(rows: readonly Row[], from: number, skip: ReadonlySet<number> = new Set()): number | null {
  const at = rows.findIndex((r) => r.index === from);
  for (let step = 1; step <= rows.length; step++) {
    const r = rows[(at + step + rows.length) % rows.length];
    if (r && r.decision === 'pending' && r.index !== from && !skip.has(r.index)) return r.index;
  }
  return null;
}

/** The chip in force: the user's pick, else the default; Needs review with nothing pending shows All. */
export function effectiveFilter(chosen: Filter | null, counts: Counts): Filter {
  const f = chosen ?? defaultFilter(counts);
  return f === 'pending' && counts.pending === 0 ? 'all' : f;
}

/** The selected entry when it is in the visible list, else the first visible one. */
export const pickSelected = (visible: readonly Row[], selected: number | null): Row | null => visible.find((r) => r.index === selected) ?? visible[0] ?? null;

/** The entry `delta` places from `from` in the visible list, clamped at the ends. */
export function stepFrom(visible: readonly Row[], from: number, delta: 1 | -1): number | null {
  if (visible.length === 0) return null;
  const at = Math.max(0, visible.findIndex((r) => r.index === from));
  return visible[Math.min(visible.length - 1, Math.max(0, at + delta))]!.index;
}
