import type { Store } from './db.js';
import type { ProjectScope } from './tickets.js';

/**
 * PR-status persistence, split out from the read-only `listPrsByTicket` in
 * dashboard.ts because this side WRITES: `prs.status` is opened as 'open' and
 * must then track the real upstream state (merged/closed/reopened/draft).
 *
 * Not append-only. A PR's status is current state, not evidence of a past event
 * — an old 'open' for a merged PR is a wrong answer stated with confidence, so
 * re-checking overwrites (same reasoning as merge_checks). The identity is the
 * PR url: it is what we queried gh about, and it is unique per PR.
 */

/** One PR that still needs syncing, plus where to run gh for it. */
export interface SyncablePr {
  ticketId: number;
  repo: string;
  number: number | null;
  url: string;
  status: string | null;
  /** A worktree path for the repo — gh's cwd, so it can resolve auth/host. */
  cwd: string;
}

export interface UpdatePrStatusInput {
  ticketId: number;
  repo: string;
  url: string;
  status: string;
}

/** Overwrite one PR's stored status, keyed by (ticket, repo, url). */
export function updatePrStatus(store: Store, input: UpdatePrStatusInput): void {
  store.db
    .prepare('UPDATE prs SET status = ? WHERE ticket_id = ? AND repo = ? AND url = ?')
    .run(input.status, input.ticketId, input.repo, input.url);
}

interface SyncableRow {
  ticket_id: number;
  repo: string;
  number: number | null;
  url: string;
  status: string | null;
  cwd: string;
}

/**
 * Every PR whose status could still change, scoped to one project.
 *
 * - `status <> 'merged'` (or null): merged is the one terminal state — it never
 *   changes again, so re-querying it is wasted gh calls. Closed is deliberately
 *   INCLUDED: a closed PR can be reopened upstream, and acceptance requires that
 *   transition to show.
 * - `url IS NOT NULL`: no url, nothing to ask gh about.
 * - the worktree JOIN both supplies gh's cwd AND drops any PR whose worktree is
 *   gone (archived): with nowhere to run gh, it is unsyncable — a graceful skip,
 *   not an error.
 * - project scope: a window must never sync another project's PRs (projects
 *   invariant). This is the only place the scope column is `t.project_id`, so the
 *   clause is inlined rather than borrowed from `scopeClause`.
 */
export function listSyncablePrs(store: Store, scope: ProjectScope = {}): SyncablePr[] {
  const scoped = scope.projectId !== undefined;
  const rows = store.db
    .prepare(
      `SELECT p.ticket_id, p.repo, p.number, p.url, p.status, w.path AS cwd
         FROM prs p
         JOIN tickets t ON t.id = p.ticket_id
         JOIN worktrees w ON w.ticket_id = p.ticket_id AND w.repo = p.repo
        WHERE (p.status IS NULL OR p.status <> 'merged')
          AND p.url IS NOT NULL
          ${scoped ? 'AND t.project_id = ?' : ''}
        GROUP BY p.ticket_id, p.repo, p.url
        ORDER BY p.ticket_id, p.repo`,
    )
    .all(...(scoped ? [scope.projectId!] : [])) as SyncableRow[];

  return rows.map((r) => ({
    ticketId: r.ticket_id,
    repo: r.repo,
    number: r.number,
    url: r.url,
    status: r.status,
    cwd: r.cwd,
  }));
}
