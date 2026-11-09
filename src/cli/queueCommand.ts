import type { Store } from '../store/db.js';
import type { PriorityLevel } from '../model/priority.js';
import { queueWhy } from '../model/queueOrder.js';
import { readProjectQueue, type PrioritySource, type ProjectQueue } from '../store/queueItems.js';

/**
 * `karst queue [--json]` — the project's queue in its computed order: pending
 * drafts (every planning session) and top-level tickets waiting at `scope`.
 * A planner reads it to find the ids to put in a draft's `dependsOn`.
 *
 * READ-ONLY: SELECTs only, so a planning session may run it through
 * `KARST_DB_READONLY` (@arch:CLI-13). The order comes from `readProjectQueue`
 * (the one read path, shared with the sidebar); this file only formats it.
 */

/** A title is cut to this many characters (the last one is an ellipsis). */
export const QUEUE_TITLE_MAX = 90;

export interface ParsedQueue {
  readonly json: boolean;
}

export interface QueueRow {
  /** 1-based place in the computed order. */
  readonly position: number;
  /** `D<n>` for a draft, `T<n>` for a ticket. */
  readonly id: string;
  /** `P<n>` of a draft's planning session; null for a ticket. */
  readonly session: string | null;
  readonly title: string;
  /** The effective level: the item's own, or the highest of the items that wait on it. */
  readonly priority: PriorityLevel;
  /** The item that raised the level above its own, or null. */
  readonly inheritedFrom: string | null;
  /** A draft's one-line planner reason, when it has one and no override replaced it; null otherwise. */
  readonly priorityReason: string | null;
  /** Who set the item's own priority: `you`, `provider` or `planner`; null when it has none. */
  readonly prioritySource: PrioritySource | null;
  /** Open blockers: pending drafts and tickets that come first, and open blockers outside the queue. */
  readonly waitsOn: readonly string[];
  readonly cycle: boolean;
  /** The short reason for the place: `cycle`, `↑ from D498`, `waits on T12`, or ''. */
  readonly why: string;
}

export interface QueueScope {
  /** The project to list; a queue is never mixed across projects. */
  readonly projectId: number;
}

export function parseQueueArgs(argv: string[]): ParsedQueue {
  const [cmd, ...rest] = argv;
  if (cmd !== 'queue') throw new Error(`expected 'queue' command, got '${cmd ?? ''}'`);
  let json = false;
  for (const flag of rest) {
    if (flag === '--json') json = true;
    else throw new Error(`unknown flag '${flag}' (want --json)`);
  }
  return { json };
}

function cut(title: string): string {
  const one = title.replace(/\s+/g, ' ').trim();
  return one.length <= QUEUE_TITLE_MAX ? one : `${one.slice(0, QUEUE_TITLE_MAX - 1)}…`;
}

export function toQueueRows(queue: ProjectQueue): QueueRow[] {
  return queue.entries.map((e) => ({
    position: e.position,
    id: e.id,
    session: e.session,
    title: cut(e.title),
    priority: e.priority,
    inheritedFrom: e.inheritedFrom,
    priorityReason: e.priorityReason,
    prioritySource: e.prioritySource,
    waitsOn: e.waitsOn,
    cycle: e.cycle,
    why: queueWhy(e),
  }));
}

export function collectQueue(store: Store, scope: QueueScope): QueueRow[] {
  return toQueueRows(readProjectQueue(store, scope.projectId));
}

const HEADERS = ['#', 'ID', 'SESSION', 'PRIO', 'TITLE', 'WHY'] as const;
const NO_SESSION = '-';

function table(rows: readonly (readonly string[])[]): string {
  const widths = HEADERS.map((_, c) => Math.max(...rows.map((r) => r[c]!.length)));
  // The last column is not padded, so a line never ends in spaces.
  return rows.map((r) => r.map((cell, c) => (c === r.length - 1 ? cell : cell.padEnd(widths[c]!))).join('  ').trimEnd()).join('\n');
}

export function formatQueueText(queue: ProjectQueue): string {
  if (queue.entries.length === 0) return 'The queue is empty: no pending draft and no ticket at scope.';
  const body = toQueueRows(queue).map((r) => [String(r.position), r.id, r.session ?? NO_SESSION, r.priority, r.title, r.why]);
  const footer = `${queue.entries.length} items · ${queue.drafts} drafts in ${queue.sessions} sessions · ${queue.tickets} tickets`;
  return `${table([[...HEADERS], ...body])}\n${footer}`;
}

export function runQueueCommand(store: Store, parsed: ParsedQueue, scope: QueueScope): string {
  const queue = readProjectQueue(store, scope.projectId);
  return parsed.json ? JSON.stringify(toQueueRows(queue), null, 2) : formatQueueText(queue);
}
