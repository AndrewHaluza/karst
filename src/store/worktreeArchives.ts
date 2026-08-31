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

export interface ArchivableWorktreesOptions extends ProjectScope {
  /**
   * Only tickets actually archived (`archived_at` set), not merely `done`.
   * The manual bulk-archive command sweeps archived-or-done; the background
   * auto-sweep rides the done-archive tick and must key on `archived_at` alone,
   * so a freshly-merged ticket's folder isn't reaped `archiveDoneAfterDays`
   * early — the done-archive's delay is what decides when a done ticket leaves
   * the board, and this sweep must not undercut it.
   */
  onlyArchived?: boolean;
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
 * Compactable archives: method is `git-ref` (not yet compacted) and the
 * archive has existed long enough to justify compacting. Each row carries
 * everything compact + restore need.
 */
export interface CompactableArchive {
  id: number;
  ticketId: number;
  repo: string;
  path: string;
  branch: string;
  baseRef: string | null;
  archiveRef: string;
  method: string;
}

export function listCompactableArchives(
  store: Store,
  olderThanMs: number,
): CompactableArchive[] {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  return (
    store.db
      .prepare(
        `SELECT id, ticket_id AS ticketId, repo, path, branch, base_ref AS baseRef,
                archive_ref AS archiveRef, method
         FROM worktree_archives
         WHERE method = 'git-ref' AND archived_at < ?
         ORDER BY id`,
      )
      .all(cutoff) as CompactableArchive[]
  );
}

/** Update a single archive row's method after compact. */
export function setArchiveMethod(store: Store, id: number, method: string): void {
  store.db.prepare('UPDATE worktree_archives SET method = ? WHERE id = ?').run(method, id);
}

/** Update a single archive row's archive_ref (e.g. when compact creates a snapshot ref for a clean tree). */
export function setArchiveRef(store: Store, id: number, archiveRef: string): void {
  store.db.prepare('UPDATE worktree_archives SET archive_ref = ? WHERE id = ?').run(archiveRef, id);
}

/**
 * All distinct branches referenced by archive rows (for orphan branch detection).
 */
export function listArchiveBranches(store: Store): { repo: string; branch: string }[] {
  return (
    store.db
      .prepare(
        `SELECT DISTINCT repo, branch FROM worktree_archives ORDER BY repo, branch`,
      )
      .all() as { repo: string; branch: string }[]
  );
}

/**
 * All distinct archive refs referenced by archive rows (for orphan ref detection).
 */
export function listArchiveRefs(store: Store): string[] {
  return (
    store.db
      .prepare(
        `SELECT DISTINCT archive_ref FROM worktree_archives WHERE archive_ref != '' ORDER BY archive_ref`,
      )
      .all() as { archive_ref: string }[]
  ).map((r) => r.archive_ref);
}

/**
 * All distinct branches referenced by active (non-archived) worktree rows
 * (for orphan branch detection — a branch used by neither worktrees nor archives is orphaned).
 */
export function listActiveWorktreeBranches(store: Store): { repo: string; branch: string }[] {
  return (
    store.db
      .prepare(
        `SELECT DISTINCT repo, branch FROM worktrees WHERE branch IS NOT NULL ORDER BY repo, branch`,
      )
      .all() as { repo: string; branch: string }[]
  );
}

/**
 * Archive rows whose branch matches a given branch in a given repo, for
 * determining whether a branch is backed by an archive.
 */
export function findArchivesByBranch(
  store: Store,
  repo: string,
  branch: string,
): ArchiveRow[] {
  return (
    store.db
      .prepare('SELECT * FROM worktree_archives WHERE repo = ? AND branch = ? ORDER BY id')
      .all(repo, branch) as Raw[]
  ).map(toRow);
}

/**
 * All archive rows (for git-ref cleanup on ticket delete).
 */
export function listAllArchivesForTicket(store: Store, ticketId: number): ArchiveRow[] {
  return (
    store.db
      .prepare('SELECT * FROM worktree_archives WHERE ticket_id = ?')
      .all(ticketId) as Raw[]
  ).map(toRow);
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
  options: ArchivableWorktreesOptions = {},
): ArchivableWorktree[] {
  const projectClause = options.projectId !== undefined ? 'AND t.project_id = ?' : '';
  const params = options.projectId !== undefined ? [options.projectId] : [];
  const inactiveClause = options.onlyArchived
    ? 't.archived_at IS NOT NULL'
    : "(t.archived_at IS NOT NULL OR t.stage_current = 'done')";
  const rows = store.db
    .prepare(
      `SELECT w.ticket_id AS ticketId, w.repo AS repoPath, w.path AS path,
              w.branch AS branch, w.base_ref AS baseRef
       FROM worktrees w
       JOIN tickets t ON t.id = w.ticket_id
       WHERE ${inactiveClause}
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
