import { PRIORITY_LEVELS, type PriorityLevel } from './priority.js';

/**
 * The one order of the project queue: pending drafts and not-started top-level
 * tickets. Pure (no store, no vscode). The sidebar host, `karst queue` and a
 * later auto-start all call this function; no other code sorts the queue.
 *
 * Rules:
 *  1. Effective priority = the highest of the item's own priority and the
 *     effective priority of every item that waits on it, transitively
 *     (priority inheritance). A missing priority reads as `normal`.
 *  2. Kahn order: an item is ready when every blocker in the set is placed.
 *     Among the ready items the next one has the highest effective priority,
 *     then the oldest `createdAt`, then the lowest id (drafts before tickets).
 *  3. A cycle never throws: its members are placed by the same keys and
 *     marked `cycle`.
 */

export interface QueueItem {
  /** `D<n>` for a draft, `T<n>` for a ticket. */
  readonly id: string;
  /** The item's own priority; null reads as `normal`. */
  readonly priority: PriorityLevel | null;
  /** Sortable timestamp (older first). */
  readonly createdAt: string;
  /** Open blockers outside the set (a running ticket, a dangling ref): shown, never ordering. */
  readonly externalWaits?: readonly string[];
}

/** `from` waits on `to`: `to` is placed first. */
export interface QueueEdge {
  readonly from: string;
  readonly to: string;
}

export interface OrderedQueueItem {
  readonly id: string;
  /** 1-based place in the queue. */
  readonly position: number;
  /** The effective priority (own, or inherited from an item that waits on this one). */
  readonly priority: PriorityLevel;
  /** The item whose own priority raised this one, or null when it keeps its own. */
  readonly inheritedFrom: string | null;
  /** Open blockers: in-set blockers first, then the external ones. */
  readonly waitsOn: readonly string[];
  readonly cycle: boolean;
}

const DEFAULT_LEVEL: PriorityLevel = 'normal';

/** Higher is more urgent: urgent 3 … low 0. */
function rank(level: PriorityLevel | null): number {
  return PRIORITY_LEVELS.length - 1 - PRIORITY_LEVELS.indexOf(level ?? DEFAULT_LEVEL);
}

function idParts(id: string): { kind: string; n: number } {
  return { kind: id.slice(0, 1), n: Number(id.slice(1)) };
}

function compareIds(a: string, b: string): number {
  const x = idParts(a);
  const y = idParts(b);
  if (x.kind !== y.kind) return x.kind < y.kind ? -1 : 1;
  if (x.n !== y.n) return x.n - y.n;
  return a < b ? -1 : a > b ? 1 : 0;
}

interface Inherited {
  readonly level: Map<string, number>;
  readonly source: Map<string, string | null>;
}

/** Fixed point of "raise a blocker to the level of the item that waits on it"; it only ever raises, so it ends, also on a cycle. */
function inheritPriority(items: readonly QueueItem[], edges: readonly QueueEdge[]): Inherited {
  const level = new Map(items.map((i) => [i.id, rank(i.priority)]));
  const source = new Map<string, string | null>(items.map((i) => [i.id, null]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const e of edges) {
      const from = level.get(e.from)!;
      if (from > level.get(e.to)!) {
        level.set(e.to, from);
        source.set(e.to, source.get(e.from) ?? e.from);
        changed = true;
      }
    }
  }
  return { level, source };
}

/** The remaining items that can reach themselves through remaining blockers. */
function cycleMembers(remaining: ReadonlySet<string>, blockers: ReadonlyMap<string, readonly string[]>): Set<string> {
  const members = new Set<string>();
  for (const start of remaining) {
    const seen = new Set<string>();
    const stack = [...(blockers.get(start) ?? [])].filter((b) => remaining.has(b));
    while (stack.length > 0) {
      const next = stack.pop()!;
      if (next === start) {
        members.add(start);
        break;
      }
      if (seen.has(next)) continue;
      seen.add(next);
      for (const b of blockers.get(next) ?? []) if (remaining.has(b)) stack.push(b);
    }
  }
  return members;
}

/** Keep the edges between two known, different items, once each. */
function cleanEdges(known: ReadonlySet<string>, edges: readonly QueueEdge[]): QueueEdge[] {
  const seen = new Set<string>();
  const out: QueueEdge[] = [];
  for (const e of edges) {
    const key = `${e.from}>${e.to}`;
    if (e.from === e.to || !known.has(e.from) || !known.has(e.to) || seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out.sort((a, b) => compareIds(a.from, b.from) || compareIds(a.to, b.to));
}

export function orderQueue(items: readonly QueueItem[], edges: readonly QueueEdge[]): OrderedQueueItem[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const clean = cleanEdges(new Set(byId.keys()), edges);
  const { level, source } = inheritPriority(items, clean);
  const blockers = new Map<string, string[]>(items.map((i) => [i.id, []]));
  for (const e of clean) blockers.get(e.from)!.push(e.to);
  const better = (a: string, b: string): number =>
    level.get(b)! - level.get(a)! ||
    (byId.get(a)!.createdAt < byId.get(b)!.createdAt ? -1 : byId.get(a)!.createdAt > byId.get(b)!.createdAt ? 1 : 0) ||
    compareIds(a, b);

  const remaining = new Set(byId.keys());
  const placed = new Set<string>();
  const cycle = new Set<string>();
  const out: OrderedQueueItem[] = [];
  while (remaining.size > 0) {
    let pool = [...remaining].filter((id) => blockers.get(id)!.every((b) => placed.has(b)));
    if (pool.length === 0) {
      const members = cycleMembers(remaining, blockers);
      for (const m of members) cycle.add(m);
      pool = [...members];
    }
    const next = pool.sort(better)[0]!;
    remaining.delete(next);
    placed.add(next);
    out.push({
      id: next,
      position: out.length + 1,
      priority: PRIORITY_LEVELS[PRIORITY_LEVELS.length - 1 - level.get(next)!]!,
      inheritedFrom: source.get(next) ?? null,
      waitsOn: [...new Set([...[...blockers.get(next)!].sort(compareIds), ...(byId.get(next)!.externalWaits ?? [])])],
      cycle: cycle.has(next),
    });
  }
  return out;
}

/** The short reason for a place: a cycle, an inherited level, or the open blockers; '' when none. */
export function queueWhy(item: Pick<OrderedQueueItem, 'cycle' | 'inheritedFrom' | 'waitsOn'>): string {
  if (item.cycle) return 'cycle';
  if (item.inheritedFrom !== null) return `↑ from ${item.inheritedFrom}`;
  return item.waitsOn.length > 0 ? `waits on ${item.waitsOn.join(', ')}` : '';
}
