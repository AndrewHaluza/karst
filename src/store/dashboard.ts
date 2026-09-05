import type { Store } from './db.js';
import { parseComments, type PrComment } from '../model/prComments.js';

/** Read models for the dashboard (§14 dashboard tier) — plain, serializable. */
export interface ServerView {
  id: number;
  ticketId: number | null;
  service: string;
  host: string | null;
  port: number | null;
  status: string;
  logPath: string | null;
}

export interface WorktreeView {
  ticketId: number;
  repo: string;
  /** How `repo` renders on the dashboard (absolute path, or project-relative). */
  repoDisplay: string;
  path: string;
  branch: string | null;
  baseRef: string | null;
  depsMode: string;
  /** When the worktree was registered; null for pre-v13 rows. */
  createdAt: string | null;
  /**
   * Whether this worktree is a karst-extension checkout and so can be
   * launched as a dev host. Only the dashboard state builder probes it (it
   * reads the filesystem); every other caller of `listWorktreesByTicket` gets
   * the inert default.
   */
  launchable: boolean;
}

export interface PrView {
  /** The rowid — the host-owned id the typed-action dispatch reloads by. */
  id: number;
  ticketId: number;
  repo: string;
  /**
   * How `repo` renders on the dashboard (absolute path, or project-relative) —
   * the same worktree path-display preference the worktree rows honor, so the
   * ship stage cannot show the same directory in a second format.
   */
  repoDisplay: string;
  number: number | null;
  url: string | null;
  status: string | null;
  /** Source branch (the "from" of from-to), or null when never probed. */
  headRef: string | null;
  /** Target branch (the "to"), or null when never probed. */
  baseRef: string | null;
  /** When the PR was opened, ISO-8601; null when never probed. */
  createdAt: string | null;
  /** When it was merged, ISO-8601; null while open, closed, or never probed. */
  mergedAt: string | null;
  /**
   * When a human declared this PR will never land (v56), ISO-8601; null while it
   * is still expected to. An acknowledgement of ours, not gh's answer — see
   * `store/prs.ts`'s `dismissPr`.
   */
  dismissedAt: string | null;
  /** Its comments, newest last. Empty for none AND for never probed. */
  comments: PrComment[];
}

interface ServerRow {
  id: number;
  ticket_id: number | null;
  repo: string;
  host: string | null;
  port: number | null;
  status: string;
  log_path: string | null;
}

/**
 * The host+port of one running server, for "Open in browser". Returns null when
 * the server row is gone or not running — a retained `stopped` (offline) row has
 * no address to open, so the dashboard offers Restart instead.
 */
export function serverAddress(
  store: Store,
  serverId: number,
): { host: string; port: number } | null {
  const row = store.db
    .prepare("SELECT host, port FROM servers WHERE id = ? AND status = 'running'")
    .get(serverId) as { host: string | null; port: number | null } | undefined;
  if (!row || row.host === null || row.port === null) return null;
  return { host: row.host, port: row.port };
}

export function listServersByTicket(store: Store, ticketId: number): ServerView[] {
  const rows = store.db
    .prepare(
      // Running AND stopped: stopped servers are retained (stopServer marks, not
      // deletes) so they surface as offline and can be restarted. Running float
      // to the top; then alphabetical by repository for a stable order.
      `SELECT id, ticket_id, repo, host, port, status, log_path FROM servers
        WHERE ticket_id = ? AND kind = 'service'
        ORDER BY CASE WHEN status = 'running' THEN 0 ELSE 1 END, repo`,
    )
    .all(ticketId) as ServerRow[];
  return rows.map((r) => ({
    id: r.id,
    ticketId: r.ticket_id,
    service: r.repo,
    host: r.host,
    port: r.port,
    status: r.status,
    logPath: r.log_path,
  }));
}

interface WorktreeRow {
  ticket_id: number;
  repo: string;
  path: string;
  branch: string | null;
  base_ref: string | null;
  deps_mode: string;
  created_at: string | null;
}

export function listWorktreesByTicket(store: Store, ticketId: number): WorktreeView[] {
  const rows = store.db
    .prepare('SELECT ticket_id, repo, path, branch, base_ref, deps_mode, created_at FROM worktrees WHERE ticket_id = ? ORDER BY path')
    .all(ticketId) as WorktreeRow[];
  return rows.map((r) => ({
    ticketId: r.ticket_id,
    repo: r.repo,
    repoDisplay: r.repo, // default; state.ts may re-render project-relative
    path: r.path,
    branch: r.branch,
    baseRef: r.base_ref,
    depsMode: r.deps_mode,
    createdAt: r.created_at,
    launchable: false, // the dashboard state builder probes the filesystem
  }));
}

/**
 * Every registered worktree of a project, joined with its ticket key. Scoped
 * like every other query: the DB is global storage, so a project's launch
 * picker must never offer another window's worktrees.
 */
export interface ProjectWorktreeRow {
  ticketId: number;
  key: string | null;
  repo: string;
  path: string;
  branch: string | null;
}

export function listWorktreesByProject(store: Store, projectId: number): ProjectWorktreeRow[] {
  return store.db
    .prepare(
      `SELECT w.ticket_id AS ticketId, t.key AS key, w.repo, w.path, w.branch
         FROM worktrees w
         JOIN tickets t ON t.id = w.ticket_id
        WHERE t.project_id = ?
        ORDER BY w.path`,
    )
    .all(projectId) as ProjectWorktreeRow[];
}

interface PrRow {
  id: number;
  ticket_id: number;
  repo: string;
  number: number | null;
  url: string | null;
  status: string | null;
  head_ref: string | null;
  base_ref: string | null;
  created_at: string | null;
  merged_at: string | null;
  dismissed_at: string | null;
  comments: string | null;
}

export function listPrsByTicket(store: Store, ticketId: number): PrView[] {
  const rows = store.db
    .prepare(
      `SELECT rowid AS id, ticket_id, repo, number, url, status, head_ref, base_ref, created_at, merged_at, dismissed_at, comments
         FROM prs WHERE ticket_id = ? ORDER BY number`,
    )
    .all(ticketId) as PrRow[];
  return rows.map((r) => ({
    id: r.id,
    ticketId: r.ticket_id,
    repo: r.repo,
    repoDisplay: r.repo, // default; state.ts may re-render project-relative
    number: r.number,
    url: r.url,
    status: r.status,
    headRef: r.head_ref,
    baseRef: r.base_ref,
    createdAt: r.created_at,
    mergedAt: r.merged_at,
    dismissedAt: r.dismissed_at,
    // A malformed column renders as no comments rather than faulting the panel —
    // this is a display cache, gh remains the source of truth.
    comments: parseComments(r.comments),
  }));
}
