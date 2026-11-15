/**
 * The Queue pane's filters: pure view logic over the host-computed rows. A row
 * keeps the position the host computed; filtering only hides rows (the host
 * never filters, so a hidden row still exists). Within one group the choices
 * are OR; the groups, the search and the chain are AND.
 */
import type { PriorityLevel } from '../../../planning/proposal.js';
import type { QueueRowView } from '../state.js';
import { LEVELS } from './priority.js';

export type QueueKind = QueueRowView['kind'];
export type QueueBlocked = 'free' | 'blocked';

export const QUEUE_KINDS: readonly QueueKind[] = ['draft', 'ticket'];
export const QUEUE_BLOCKED: readonly QueueBlocked[] = ['free', 'blocked'];

/** The filters of the Queue pane. Persisted in the webview view state; never posted to the host. */
export interface QueueFilters {
  readonly kinds: readonly QueueKind[];
  /** Session labels (`P52`). */
  readonly sessions: readonly string[];
  readonly levels: readonly PriorityLevel[];
  readonly blocked: readonly QueueBlocked[];
  /** The id (`D562`) whose dependency chain is shown, or null. */
  readonly chain: string | null;
}

export const NO_QUEUE_FILTERS: QueueFilters = { kinds: [], sessions: [], levels: [], blocked: [], chain: null };

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const only = <T extends string>(v: unknown, allowed: readonly T[]): T[] => strings(v).filter((x): x is T => (allowed as readonly string[]).includes(x));

/** Read persisted filters defensively: an older snapshot has none, a corrupt one has odd types. */
export function restoreQueueFilters(prev: unknown): QueueFilters {
  const v = (prev ?? {}) as Record<string, unknown>;
  return {
    kinds: only(v.kinds, QUEUE_KINDS),
    sessions: strings(v.sessions).filter((s) => /^P\d+$/.test(s)),
    levels: only(v.levels, LEVELS),
    blocked: only(v.blocked, QUEUE_BLOCKED),
    chain: typeof v.chain === 'string' && /^[DT]\d+$/.test(v.chain) ? v.chain : null,
  };
}

/** The filters with a chain or a session that left the queue dropped, so no dead choice keeps the funnel lit. */
export function liveFilters(rows: readonly QueueRowView[], f: QueueFilters): QueueFilters {
  const chain = f.chain !== null && rows.some((r) => r.idLabel === f.chain) ? f.chain : null;
  const labels = new Set(rows.map((r) => r.sessionLabel));
  const sessions = f.sessions.filter((s) => labels.has(s));
  return chain === f.chain && sessions.length === f.sessions.length ? f : { ...f, chain, sessions };
}

export function hasQueueFilters(f: QueueFilters): boolean {
  return f.kinds.length + f.sessions.length + f.levels.length + f.blocked.length > 0 || f.chain !== null;
}

/** A new array with `value` added or removed. */
export function toggledValue<T>(list: readonly T[], value: T): T[] {
  return list.includes(value) ? list.filter((x) => x !== value) : [...list, value];
}

export const isBlocked = (row: QueueRowView): boolean => row.waitsOn.length > 0;

/** `P52 · offloading`, or `P52` when the session has no title. */
export function sessionText(label: string, title: string | null): string {
  return title ? `${label} · ${title}` : label;
}

/** The in-queue ids a row is linked to, in either direction. */
function links(row: QueueRowView, inQueue: ReadonlySet<string>): string[] {
  return [...row.waitsOn.filter((id) => inQueue.has(id)), ...row.unblocks.filter((id) => inQueue.has(id))];
}

/** A row gets the chain control only when it waits on a queue item or a queue item waits on it. */
export function hasChain(row: QueueRowView, rows: readonly QueueRowView[]): boolean {
  return links(row, new Set(rows.map((r) => r.idLabel))).length > 0;
}

/** The row, everything it waits on (transitively) and everything that waits on it (transitively). */
export function chainIds(rows: readonly QueueRowView[], id: string): Set<string> {
  const byId = new Map(rows.map((r) => [r.idLabel, r]));
  const walk = (from: string, next: (r: QueueRowView) => readonly string[]): Set<string> => {
    const seen = new Set<string>();
    const todo = [from];
    for (let cur = todo.pop(); cur !== undefined; cur = todo.pop()) {
      for (const n of byId.get(cur) ? next(byId.get(cur)!) : []) {
        if (byId.has(n) && !seen.has(n)) {
          seen.add(n);
          todo.push(n);
        }
      }
    }
    return seen;
  };
  return new Set([id, ...walk(id, (r) => r.waitsOn), ...walk(id, (r) => r.unblocks)]);
}

/** Case-insensitive search over the id, the session id, the session title and the title. */
export function matchesQuery(row: QueueRowView, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === '') return true;
  return [row.idLabel, row.sessionLabel, row.sessionTitle, row.title].some((t) => t !== null && t.toLowerCase().includes(needle));
}

/** The chain filter only holds while its row is still in the queue. */
export function activeChain(rows: readonly QueueRowView[], f: QueueFilters): Set<string> | null {
  return f.chain !== null && rows.some((r) => r.idLabel === f.chain) ? chainIds(rows, f.chain) : null;
}

function inGroup<T>(chosen: readonly T[], value: T | null): boolean {
  return chosen.length === 0 || (value !== null && chosen.includes(value));
}

export function rowShown(row: QueueRowView, f: QueueFilters, chain: ReadonlySet<string> | null, query: string): boolean {
  return (
    inGroup(f.kinds, row.kind) &&
    inGroup(f.sessions, row.sessionLabel) &&
    inGroup(f.levels, row.level) &&
    inGroup(f.blocked, isBlocked(row) ? 'blocked' : 'free') &&
    (chain === null || chain.has(row.idLabel)) &&
    matchesQuery(row, query)
  );
}

export type QueueListItem = { readonly row: QueueRowView } | { readonly gap: number };

export interface FilteredQueue {
  readonly shown: number;
  readonly items: readonly QueueListItem[];
}

/** The visible rows in computed order, with one gap item for each run of hidden rows. */
export function filterQueue(rows: readonly QueueRowView[], f: QueueFilters, query: string): FilteredQueue {
  const chain = activeChain(rows, f);
  const items: QueueListItem[] = [];
  let hidden = 0;
  let shown = 0;
  for (const row of rows) {
    if (rowShown(row, f, chain, query)) {
      if (hidden > 0) items.push({ gap: hidden });
      hidden = 0;
      shown += 1;
      items.push({ row });
    } else {
      hidden += 1;
    }
  }
  if (hidden > 0 && shown > 0) items.push({ gap: hidden });
  return { shown, items };
}

export interface QueueSession {
  readonly label: string;
  readonly title: string | null;
  readonly count: number;
}

/** One entry per session in the queue, in first-seen (queue) order. */
export function queueSessions(rows: readonly QueueRowView[]): QueueSession[] {
  const found = new Map<string, { title: string | null; count: number }>();
  for (const r of rows) {
    if (r.sessionLabel === null) continue;
    const cur = found.get(r.sessionLabel);
    found.set(r.sessionLabel, { title: cur?.title ?? r.sessionTitle, count: (cur?.count ?? 0) + 1 });
  }
  return [...found].map(([label, v]) => ({ label, title: v.title, count: v.count }));
}
