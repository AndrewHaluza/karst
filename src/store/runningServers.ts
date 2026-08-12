import type { Store } from './db.js';

/**
 * SELECT-only reads over `servers` for the resource monitor (§ resource
 * monitor). This module must never contain `INSERT`, `UPDATE`, or `DELETE` —
 * it is a read the monitor feeds on, and the whole point of separating it is
 * that observation never mutates.
 *
 * Positional `?` binding only, per the driver-agnostic rule — the same helpers
 * must work under `node:sqlite` if the CLI ever grows a monitoring verb.
 */

export interface RunningServerRow {
  id: number;
  ticketId: number | null;
  repo: string;
  pid: number | null;
  cwd: string | null;
  startedAt: string | null;
  host: string | null;
  port: number | null;
}

/**
 * Every `servers` row still claiming to be running.
 *
 * Scoped to a project's tickets when `projectId` is given. Baseline rows
 * (`ticket_id IS NULL`) are ALWAYS included: they belong to the repository
 * checkout, not to one project's ticket. A running row with `pid IS NULL` is
 * returned as-is — the inventory treats a null pid as unattributable.
 */
export function listRunningServers(store: Store, projectId?: number): RunningServerRow[] {
  let sql =
    'SELECT s.id, s.ticket_id AS ticketId, s.repo, s.pid, s.cwd, s.started_at AS startedAt, s.host, s.port FROM servers s WHERE s.status = \'running\'';
  const params: unknown[] = [];
  if (projectId !== undefined) {
    sql +=
      ' AND (s.ticket_id IS NULL OR s.ticket_id IN (SELECT id FROM tickets WHERE project_id = ?))';
    params.push(projectId);
  }
  sql += ' ORDER BY s.id';
  return store.db.prepare(sql).all(...params) as RunningServerRow[];
}

export interface TicketLifecycle {
  id: number;
  key: string | null;
  title: string | null;
  stageCurrent: string | null;
  archived: boolean;
}

/**
 * Lifecycle facts the waste rules need: is this ticket done, or archived?
 * Returns an empty map for an empty `ids` array without querying. Unknown ids
 * are simply absent from the map — "unknown" is never "finished".
 */
export function listTicketLifecycle(
  store: Store,
  ids: readonly number[],
): Map<number, TicketLifecycle> {
  const map = new Map<number, TicketLifecycle>();
  if (ids.length === 0) return map;
  const placeholders = ids.map(() => '?').join(',');
  const rows = store.db
    .prepare(
      `SELECT id, key, title, stage_current AS stageCurrent, archived_at AS archivedAt FROM tickets WHERE id IN (${placeholders})`,
    )
    .all(...ids) as Array<{
    id: number;
    key: string | null;
    title: string | null;
    stageCurrent: string | null;
    archivedAt: string | null;
  }>;
  for (const row of rows) {
    map.set(row.id, {
      id: row.id,
      key: row.key,
      title: row.title,
      stageCurrent: row.stageCurrent,
      archived: row.archivedAt !== null,
    });
  }
  return map;
}
