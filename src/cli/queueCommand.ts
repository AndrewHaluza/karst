import type { Store } from '../store/db.js';
import { formatId } from '../model/entityId.js';
import { asPriorityLevel, type PriorityLevel } from '../planning/proposal.js';
import { effectiveProposalPriority, listProjectProposals } from '../store/planningProposals.js';
import { listOpenBlockers } from '../store/ticketRelations.js';

/**
 * `karst queue [--json]` — the project's pending drafts (every planning
 * session) and its top-level tickets still waiting at `scope`, so a planner can
 * find the ids to put in a draft's `dependsOn`.
 *
 * READ-ONLY: SELECTs only, so a planning session may run it through
 * `KARST_DB_READONLY` (@arch:CLI-13). Order is by id, drafts first.
 */

/** A title is cut to this many characters (the last one is an ellipsis). */
export const QUEUE_TITLE_MAX = 90;
/** Top-level tickets listed here are the ones that have not started. */
const NOT_STARTED_STAGE = 'scope';

export interface ParsedQueue {
  readonly json: boolean;
}

export interface QueueRow {
  /** `D<n>` for a draft, `T<n>` for a ticket. */
  readonly id: string;
  /** `P<n>` of a draft's planning session; null for a ticket. */
  readonly session: string | null;
  readonly title: string;
  /** The draft's effective priority (your override, else the planner's) or the ticket's own; null when none (reads as normal). */
  readonly priority: PriorityLevel | null;
  /** A draft's one-line planner reason, when it has one and no override replaced it; null otherwise. */
  readonly priorityReason: string | null;
  /** A draft's `dependsOn` entries, or a ticket's open blockers. */
  readonly dependsOn: readonly string[];
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

export function collectQueue(store: Store, scope: QueueScope): QueueRow[] {
  const drafts: QueueRow[] = listProjectProposals(store, scope.projectId)
    .filter((p) => p.status === 'pending')
    .map((p) => ({
      id: formatId('draft', p.id),
      session: formatId('plan', p.sessionId),
      title: cut(p.payload.title),
      priority: effectiveProposalPriority(p),
      priorityReason: p.priorityOverride === null ? (p.payload.priorityReason ?? null) : null,
      dependsOn: (p.payload.dependsOn ?? []).map((d) => (typeof d === 'number' ? formatId('draft', d) : d)),
    }));
  const tickets = store.db
    .prepare(
      `SELECT id, COALESCE(title, key, '') AS title, priority FROM tickets
        WHERE project_id = ? AND archived_at IS NULL AND subtask_parent_id IS NULL
          AND stage_current = ?
        ORDER BY id`,
    )
    .all(scope.projectId, NOT_STARTED_STAGE) as { id: number; title: string; priority: string | null }[];
  const ticketRows: QueueRow[] = tickets.map((t) => ({
    id: formatId('ticket', t.id),
    session: null,
    title: cut(t.title),
    priority: asPriorityLevel(t.priority) ?? null,
    priorityReason: null,
    dependsOn: listOpenBlockers(store, t.id).map((b) => b.label),
  }));
  return [...drafts, ...ticketRows];
}

function renderRow(r: QueueRow): string {
  const session = r.session === null ? '' : `  ${r.session}`;
  const waits = r.dependsOn.length === 0 ? '' : `  needs ${r.dependsOn.join(', ')}`;
  const priority = r.priority === null ? '' : `  ${r.priority}`;
  const why = r.priorityReason === null ? '' : `  (${r.priorityReason})`;
  return `${r.id}${session}${priority}  ${r.title}${why}${waits}`;
}

export function runQueueCommand(store: Store, parsed: ParsedQueue, scope: QueueScope): string {
  const rows = collectQueue(store, scope);
  if (parsed.json) return JSON.stringify(rows, null, 2);
  return rows.length === 0 ? 'The queue is empty: no pending draft and no ticket at scope.' : rows.map(renderRow).join('\n');
}
