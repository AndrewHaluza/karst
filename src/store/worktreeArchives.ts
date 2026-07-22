import type { Store } from './db.js';
import type { ProjectScope } from './tickets.js';

export interface ArchiveRow {
  id: number;
  ticketId: number;
  repo: string;
  path: string;
  branch: string;
  baseRef: string | null;
  archiveRef: string;
  method: string;
  archivedAt: string;
}

export interface NewArchive {
  ticketId: number;
  repo: string;
  path: string;
  branch: string;
  baseRef: string | null;
  archiveRef: string;
  method: string;
}

export interface ArchivableWorktree {
  ticketId: number;
  repoPath: string;
  path: string;
  branch: string;
  baseRef: string;
}

interface Raw {
  id: number;
  ticket_id: number;
  repo: string;
  path: string;
  branch: string;
  base_ref: string | null;
  archive_ref: string;
  method: string;
  archived_at: string;
}

function toRow(r: Raw): ArchiveRow {
  return {
    id: r.id,
    ticketId: r.ticket_id,
    repo: r.repo,
    path: r.path,
    branch: r.branch,
    baseRef: r.base_ref,
    archiveRef: r.archive_ref,
    method: r.method,
    archivedAt: r.archived_at,
  };
}

/** Insert a worktree-archive row (append-only registry of archived worktrees). */
export function recordArchive(store: Store, a: NewArchive): void {
  store.db
    .prepare(
      `INSERT INTO worktree_archives (ticket_id, repo, path, branch, base_ref, archive_ref, method)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(a.ticketId, a.repo, a.path, a.branch, a.baseRef, a.archiveRef, a.method);
}

/** All archive rows for a ticket, oldest first. */
export function listArchives(store: Store, ticketId: number): ArchiveRow[] {
  return (
    store.db
      .prepare('SELECT * FROM worktree_archives WHERE ticket_id = ? ORDER BY id')
      .all(ticketId) as Raw[]
  ).map(toRow);
}

/** The most recent archive row for a ticket's worktree path, or null. */
export function getArchiveByPath(store: Store, ticketId: number, path: string): ArchiveRow | null {
  const r = store.db
    .prepare('SELECT * FROM worktree_archives WHERE ticket_id = ? AND path = ? ORDER BY id DESC LIMIT 1')
    .get(ticketId, path) as Raw | undefined;
  return r ? toRow(r) : null;
}

/** Delete an archive row by id (called after a successful restore). */
export function clearArchive(store: Store, id: number): void {
  store.db.prepare('DELETE FROM worktree_archives WHERE id = ?').run(id);
}

/**
 * Worktrees eligible for bulk archiving: the ticket is archived or terminal
 * (`stage_current = 'done'`) AND its agent is not currently running. Only rows
 * with a branch are returned — archive/restore both need it.
 *
 * Scoped by project like every other ticket query (§ projects / multi-window):
 * the DB is shared across IDE windows, so an unscoped call — the deliberate
 * "all projects" recovery view — would otherwise let one window's bulk archive
 * reap another project's worktrees.
 */
export function listArchivableWorktrees(
  store: Store,
  scope: ProjectScope = {},
): ArchivableWorktree[] {
  const projectClause = scope.projectId !== undefined ? 'AND t.project_id = ?' : '';
  const params = scope.projectId !== undefined ? [scope.projectId] : [];
  const rows = store.db
    .prepare(
      `SELECT w.ticket_id AS ticketId, w.repo AS repoPath, w.path AS path,
              w.branch AS branch, w.base_ref AS baseRef
       FROM worktrees w
       JOIN tickets t ON t.id = w.ticket_id
       WHERE (t.archived_at IS NOT NULL OR t.stage_current = 'done')
         AND (t.agent_state IS NULL OR t.agent_state != 'running')
         ${projectClause}
       ORDER BY w.path`,
    )
    .all(...params) as {
    ticketId: number;
    repoPath: string;
    path: string;
    branch: string | null;
    baseRef: string | null;
  }[];
  return rows
    .filter((r): r is typeof r & { branch: string } => r.branch != null)
    .map((r) => ({
      ticketId: r.ticketId,
      repoPath: r.repoPath,
      path: r.path,
      branch: r.branch,
      baseRef: r.baseRef ?? r.branch,
    }));
}
