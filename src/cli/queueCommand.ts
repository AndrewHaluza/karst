import type { Store } from '../store/db.js';
import { formatId } from '../model/entityId.js';
import { listProjectProposals } from '../store/planningProposals.js';
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
      dependsOn: (p.payload.dependsOn ?? []).map((d) => (typeof d === 'number' ? formatId('draft', d) : d)),
    }));
  const tickets = store.db
    .prepare(
      `SELECT id, COALESCE(title, key, '') AS title FROM tickets
        WHERE project_id = ? AND archived_at IS NULL AND subtask_parent_id IS NULL
          AND stage_current = ?
        ORDER BY id`,
    )
    .all(scope.projectId, NOT_STARTED_STAGE) as { id: number; title: string }[];
  const ticketRows: QueueRow[] = tickets.map((t) => ({
    id: formatId('ticket', t.id),
    session: null,
    title: cut(t.title),
    dependsOn: listOpenBlockers(store, t.id).map((b) => b.label),
  }));
  return [...drafts, ...ticketRows];
}

function renderRow(r: QueueRow): string {
  const session = r.session === null ? '' : `  ${r.session}`;
  const waits = r.dependsOn.length === 0 ? '' : `  needs ${r.dependsOn.join(', ')}`;
  return `${r.id}${session}  ${r.title}${waits}`;
}

export function runQueueCommand(store: Store, parsed: ParsedQueue, scope: QueueScope): string {
  const rows = collectQueue(store, scope);
  if (parsed.json) return JSON.stringify(rows, null, 2);
  return rows.length === 0 ? 'The queue is empty: no pending draft and no ticket at scope.' : rows.map(renderRow).join('\n');
}
