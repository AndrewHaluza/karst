import type { Store } from './db.js';

/**
 * One ticket that declared a dependency on a baseline service, with the facts a
 * "who would this stop affect" prompt needs. Written by `runtime/baseline.ts` at
 * each spin; read here and by `store/sharedServers.ts`.
 *
 * Rows whose ticket has since been deleted are excluded by the join — a stale
 * ref must not inflate the count behind a prompt a human is reading.
 */
export interface BaselineDependent {
  ticketId: number;
  key: string | null;
  title: string | null;
  stageCurrent: string | null;
  /** Soft-deleted: its worktrees are gone, so it is never live. */
  archived: boolean;
  /** It still has a running service of its own — a live stack to break. */
  hasRunningService: boolean;
}

interface DependentRow {
  ticketId: number;
  key: string | null;
  title: string | null;
  stageCurrent: string | null;
  archived: number;
  hasRunningService: number;
}

/**
 * Every ticket that declared a dependency on the baseline `repo`. Returns the
 * RAW rows, including archived ones: the caller decides what counts as live, so
 * this read stays a fact rather than a policy.
 */
export function listBaselineDependentsDetailed(
  store: Store,
  repo: string,
): BaselineDependent[] {
  const rows = store.db
    .prepare(
      `SELECT b.ticket_id AS ticketId, t.key AS key, t.title AS title,
              t.stage_current AS stageCurrent,
              (t.archived_at IS NOT NULL) AS archived,
              EXISTS(SELECT 1 FROM servers s
                      WHERE s.ticket_id = b.ticket_id AND s.kind = 'service'
                        AND s.status = 'running') AS hasRunningService
         FROM baseline_refs b
         JOIN tickets t ON t.id = b.ticket_id
        WHERE b.repo = ?
        ORDER BY b.ticket_id`,
    )
    .all(repo) as DependentRow[];
  return rows.map((r) => ({
    ticketId: r.ticketId,
    key: r.key,
    title: r.title,
    stageCurrent: r.stageCurrent,
    archived: r.archived === 1,
    hasRunningService: r.hasRunningService === 1,
  }));
}

/**
 * Whether stopping the baseline would take a live stack out from under this
 * ticket.
 *
 * A done ticket counts ONLY while it still runs a service of its own: the shared
 * copy is exactly what that running stack is wired to, and stopping it breaks
 * the stack. An archived ticket never counts — its worktrees are gone, so there
 * is nothing left to break.
 *
 * The ref itself is kept either way: `runtime/startOne.ts` reads `baseline_refs`
 * to avoid re-pointing a baseline to an alt port, so filtering (never deleting)
 * is what keeps that wiring intact.
 */
export function isLiveBaselineDependent(d: BaselineDependent): boolean {
  return !d.archived && (d.stageCurrent !== 'done' || d.hasRunningService);
}

/**
 * The same answer addressed by `servers.id`, for a caller that holds a row id
 * rather than a repository name. Returns `[]` for a row that is not a baseline
 * (`ticket_id IS NOT NULL`) and for a row that no longer exists.
 *
 * Only the LIVE dependents: the stop confirmation names exactly the tickets the
 * stop would affect.
 */
export function baselineDependentsFor(store: Store, serverId: number): BaselineDependent[] {
  const row = store.db
    .prepare('SELECT repo, ticket_id FROM servers WHERE id = ?')
    .get(serverId) as { repo: string; ticket_id: number | null } | undefined;
  if (!row || row.ticket_id !== null) return [];
  return listBaselineDependentsDetailed(store, row.repo).filter(isLiveBaselineDependent);
}
