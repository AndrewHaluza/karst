import type { Store } from './db.js';

/** Read models for the dashboard (§14 dashboard tier) — plain, serializable. */
export interface ServerView {
  id: number;
  ticketId: number | null;
  service: string;
  host: string | null;
  port: number | null;
  status: string;
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
}

export interface PrView {
  ticketId: number;
  repo: string;
  number: number | null;
  url: string | null;
  status: string | null;
}

interface ServerRow {
  id: number;
  ticket_id: number | null;
  service: string;
  host: string | null;
  port: number | null;
  status: string;
}

/**
 * The host+port of one running server, for "Open in browser". Returns null when
 * the server row is gone or not running (stopped rows are deleted, so this is
 * normally just the deleted case).
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
      // Only live servers reach the dashboard. stopServer deletes rows, so this
      // is normally moot — but a crash could leave a stale 'running' row until
      // reconcile prunes it; filtering keeps the read path self-defending and
      // never shows a dead server.
      "SELECT id, ticket_id, service, host, port, status FROM servers WHERE ticket_id = ? AND status = 'running' ORDER BY service",
    )
    .all(ticketId) as ServerRow[];
  return rows.map((r) => ({
    id: r.id,
    ticketId: r.ticket_id,
    service: r.service,
    host: r.host,
    port: r.port,
    status: r.status,
  }));
}

interface WorktreeRow {
  ticket_id: number;
  repo: string;
  path: string;
  branch: string | null;
  base_ref: string | null;
  deps_mode: string;
}

export function listWorktreesByTicket(store: Store, ticketId: number): WorktreeView[] {
  const rows = store.db
    .prepare('SELECT ticket_id, repo, path, branch, base_ref, deps_mode FROM worktrees WHERE ticket_id = ? ORDER BY path')
    .all(ticketId) as WorktreeRow[];
  return rows.map((r) => ({
    ticketId: r.ticket_id,
    repo: r.repo,
    repoDisplay: r.repo, // default; state.ts may re-render project-relative
    path: r.path,
    branch: r.branch,
    baseRef: r.base_ref,
    depsMode: r.deps_mode,
  }));
}

interface PrRow {
  ticket_id: number;
  repo: string;
  number: number | null;
  url: string | null;
  status: string | null;
}

export function listPrsByTicket(store: Store, ticketId: number): PrView[] {
  const rows = store.db
    .prepare('SELECT ticket_id, repo, number, url, status FROM prs WHERE ticket_id = ? ORDER BY number')
    .all(ticketId) as PrRow[];
  return rows.map((r) => ({
    ticketId: r.ticket_id,
    repo: r.repo,
    number: r.number,
    url: r.url,
    status: r.status,
  }));
}
