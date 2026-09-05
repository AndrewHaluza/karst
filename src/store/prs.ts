import type { Store } from './db.js';
import type { ProjectScope } from './tickets.js';
import type { PrDetail } from '../integrations/github.js';
import { serializeComments } from '../model/prComments.js';

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
  /**
   * The branch the worktree was cut from, or null. Carried for the merge sweep,
   * which needs something to measure against and must never guess one.
   *
   * NOT the PR's target branch — that is `prBaseRef` below. The two differ
   * whenever the manifest's baseline moved after the worktree was cut.
   */
  baseRef: string | null;
  /**
   * The v16 metadata as STORED, so the sweep can tell whether a probe actually
   * moved anything and skip a dashboard refresh when it did not. `prComments` is
   * the raw column, compared as text — cheaper than parsing to compare.
   */
  prHeadRef: string | null;
  prBaseRef: string | null;
  prCreatedAt: string | null;
  prMergedAt: string | null;
  prComments: string | null;
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

export interface RecordShippedPrInput {
  ticketId: number;
  repo: string;
  number: number | null;
  url: string;
}

/**
 * Idempotent write for the row ship creates right after opening (or adopting)
 * a PR (Defect 3: the plain INSERT this replaced could double-insert once
 * `updatePrDetail` overwrote `status` from 'open' to the PR's real upstream
 * state — 'draft' for a draft PR — because the retry guard only matched
 * `status = 'open'` and so missed it, re-adopted the same GitHub PR, and
 * inserted a second row for the same (ticket, repo, url)).
 *
 * Keyed by (ticket_id, repo, url) — the same identity `updatePrDetail` uses.
 * A matching row has its `number` refreshed and KEEPS its stored status; a
 * fresh row is inserted as 'open'. Either way there is exactly one row per
 * (ticket, repo, url) afterward.
 *
 * Not resetting the status is the same F4 rule `updatePrDetail` follows: a
 * status already probed from GitHub is a real answer, and re-shipping a PR
 * karst merely re-adopted does not make a draft PR undrafted. Overwriting it
 * with 'open' would be a guess replacing a fact — and it would STICK, because
 * the `fetchPrDetail` probe that follows is allowed to fail (it degrades to
 * `UNKNOWN_PR_DETAIL`, whose 'unknown' status `updatePrDetail` drops rather
 * than storing).
 */
export function recordShippedPr(store: Store, input: RecordShippedPrInput): void {
  const existing = store.db
    .prepare(`SELECT rowid FROM prs WHERE ticket_id = ? AND repo = ? AND url = ?`)
    .get(input.ticketId, input.repo, input.url) as { rowid: number } | undefined;
  if (existing) {
    store.db
      .prepare(`UPDATE prs SET number = ? WHERE rowid = ?`)
      .run(input.number, existing.rowid);
    return;
  }
  store.db
    .prepare(
      `INSERT INTO prs (ticket_id, repo, number, url, status) VALUES (?, ?, ?, ?, 'open')`,
    )
    .run(input.ticketId, input.repo, input.number, input.url);
}

export interface UpdatePrDetailInput {
  ticketId: number;
  repo: string;
  url: string;
  detail: PrDetail;
}

/**
 * Write one PR's status AND the v16 metadata the ship stage renders.
 *
 * Every field is written as "the new value, or keep what is stored" (COALESCE), so
 * a probe that saw less than the last one never erases known facts — a partial
 * answer is a partial answer, not a correction to null. Three consequences worth
 * keeping:
 *
 *  - `status: 'unknown'` is dropped entirely (F4: never overwrite a real status
 *    with a guess), while any metadata that same probe DID state still lands.
 *  - `comments: null` ("gh did not say") keeps the stored thread; `comments: []`
 *    ("this PR has no comments") clears it. The two must not collapse.
 *  - `mergedAt` cannot be un-set by a later probe. It is a fact about an event
 *    that happened; a probe that stops reporting it is a degraded probe, not an
 *    unmerge.
 */
export function updatePrDetail(store: Store, input: UpdatePrDetailInput): void {
  const { detail } = input;
  store.db
    .prepare(
      `UPDATE prs SET
         status     = CASE WHEN ? IS NULL THEN status ELSE ? END,
         head_ref   = COALESCE(?, head_ref),
         base_ref   = COALESCE(?, base_ref),
         created_at = COALESCE(?, created_at),
         merged_at  = COALESCE(?, merged_at),
         comments   = COALESCE(?, comments)
       WHERE ticket_id = ? AND repo = ? AND url = ?`,
    )
    .run(
      // 'unknown' is not a status to store — it is the absence of an answer.
      detail.status === 'unknown' ? null : detail.status,
      detail.status === 'unknown' ? null : detail.status,
      detail.headRef,
      detail.baseRef,
      detail.createdAt,
      detail.mergedAt,
      serializeComments(detail.comments),
      input.ticketId,
      input.repo,
      input.url,
    );
}

export interface DismissPrInput {
  ticketId: number;
  /** The repository whose CURRENT PR is being dismissed (a `prs.repo` value). */
  repo: string;
  /** The dismissal stamp — injected, never read from a clock in here. */
  at: string;
}

/** The repo's CURRENT PR rowid + status, or undefined when it has none. */
function currentPrRow(
  store: Store,
  ticketId: number,
  repo: string,
): { rowid: number; status: string | null } | undefined {
  return store.db
    .prepare(
      `SELECT rowid, status FROM prs
        WHERE ticket_id = ? AND repo = ? AND url IS NOT NULL
        ORDER BY CASE WHEN status = 'open' THEN 0 ELSE 1 END, number DESC
        LIMIT 1`,
    )
    .get(ticketId, repo) as { rowid: number; status: string | null } | undefined;
}

/**
 * Record that a repo's PR will never land — the escape hatch for a ticket whose
 * PR was CLOSED because the changes turned out to be unneeded.
 *
 * Without it such a ticket parks at `ship` forever: `mergeGateState` waits for a
 * literal `'merged'`, and a closed PR can never reach it, so the gate has no
 * terminating answer and no user action can supply one.
 *
 * Deliberately a column of ours rather than a status value: `status` is gh's
 * answer and `prSync` overwrites it, so an acknowledgement stored there would be
 * erased by the next probe. Refuses a merged PR — landing is the outcome, not
 * abandonment — and returns false rather than throwing when the repo has no PR,
 * because the repo name arrives from a webview a stale panel may have rendered.
 */
export function dismissPr(store: Store, input: DismissPrInput): boolean {
  const row = currentPrRow(store, input.ticketId, input.repo);
  if (row === undefined || row.status === 'merged') return false;
  store.db.prepare('UPDATE prs SET dismissed_at = ? WHERE rowid = ?').run(input.at, row.rowid);
  return true;
}

/**
 * Undo a dismissal, so a PR reopened upstream (or dismissed by mistake) blocks
 * the gate again. Same tolerance as `dismissPr`: an absent PR is false, not a
 * throw.
 */
export function undismissPr(store: Store, input: { ticketId: number; repo: string }): boolean {
  const row = currentPrRow(store, input.ticketId, input.repo);
  if (row === undefined) return false;
  store.db.prepare('UPDATE prs SET dismissed_at = NULL WHERE rowid = ?').run(row.rowid);
  return true;
}

/**
 * Which of a repo's PR rows is the CURRENT one.
 *
 * A repo can hold several: `ship` inserts a fresh row rather than reusing a
 * terminal one, so a repo re-shipped after a merge carries both the merged PR and
 * the new open one. An open PR is the current one; otherwise the newest number
 * wins. Shared so that "which PR is this repo's PR" has exactly one answer —
 * `mergeChecks.ts` asks the same question to decide whether its stored verdict
 * still describes anything.
 */
export const CURRENT_PR_ORDER = `ORDER BY CASE WHEN p.status = 'open' THEN 0 ELSE 1 END, p.number DESC`;

/** One repo's CURRENT PR on a ticket, reduced to what the merge gate asks about. */
export interface CurrentPr {
  repo: string;
  number: number | null;
  url: string;
  status: string | null;
  /**
   * When a human declared this PR will never land (v56), else null. The merge
   * gate stops waiting on a dismissed PR — see `dismissPr`.
   */
  dismissedAt: string | null;
}

/**
 * One row per repo — the repo's CURRENT PR — for every repo this ticket opened a
 * PR in.
 *
 * The merge gate asks "has everything this ticket delivered landed", and the only
 * honest way to answer it is per REPO: `listPrsByTicket` returns every row a repo
 * ever accumulated, so a repo re-shipped after a merge would answer twice, and
 * the merged half would say yes for a branch still open. `CURRENT_PR_ORDER` is
 * the same rule `findTicketPr` and `mergeChecks` apply, so all three agree on
 * which PR a repo means.
 *
 * Deliberately NOT joined to `worktrees` (unlike `findTicketPr`/`listSyncablePrs`,
 * which need a cwd to run gh in): a merged PR whose worktree has since been
 * archived is still merged, and dropping it would make a fully-landed ticket look
 * like it had delivered nothing.
 */
export function listCurrentPrsByTicket(store: Store, ticketId: number): CurrentPr[] {
  const rows = store.db
    .prepare(
      `SELECT pr.repo, pr.number, pr.url, pr.status, pr.dismissed_at
         FROM prs pr
        WHERE pr.ticket_id = ?
          AND pr.url IS NOT NULL
          AND pr.rowid = (SELECT p.rowid
                            FROM prs p
                           WHERE p.ticket_id = pr.ticket_id
                             AND p.repo = pr.repo
                             AND p.url IS NOT NULL
                           ${CURRENT_PR_ORDER}
                           LIMIT 1)
        ORDER BY pr.repo`,
    )
    .all(ticketId) as Array<{
      repo: string;
      number: number | null;
      url: string;
      status: string | null;
      dismissed_at: string | null;
    }>;
  return rows.map((r) => ({
    repo: r.repo,
    number: r.number,
    url: r.url,
    status: r.status,
    dismissedAt: r.dismissed_at,
  }));
}

/**
 * One PR row by its rowid, whatever ticket it belongs to — the typed-action
 * dispatch reloads the row by host-owned id and verifies the ticket itself
 * (`insideActions.ts`). The rowid IS the host-owned id (the table has no
 * surrogate primary key of its own). `ticketId` is carried so the caller can
 * prove ownership before acting.
 */
export function getPrById(store: Store, id: number): (CurrentPr & { ticketId: number }) | undefined {
  const row = store.db
    .prepare(
      `SELECT ticket_id, repo, number, url, status, dismissed_at FROM prs WHERE rowid = ? AND url IS NOT NULL`,
    )
    .get(id) as
    | {
        ticket_id: number;
        repo: string;
        number: number | null;
        url: string;
        status: string | null;
        dismissed_at: string | null;
      }
    | undefined;
  if (row === undefined) return undefined;
  return {
    ticketId: row.ticket_id,
    repo: row.repo,
    number: row.number,
    url: row.url,
    status: row.status,
    dismissedAt: row.dismissed_at,
  };
}

/** One repo's PR on a ticket, with the worktree path gh must run in. */
export interface TicketPr {
  ticketId: number;
  repo: string;
  number: number | null;
  url: string;
  status: string | null;
  /** The PR's target branch, or null when never probed — names what a merge lands in. */
  baseRef: string | null;
  /** A worktree path for the repo — gh's cwd, so it can resolve auth/host. */
  cwd: string;
}

/**
 * The PR to act on for one (ticket, repo), or null.
 *
 * Null — never a throw — for every reason there is nothing to act on: no PR row,
 * a row with no url (nothing to name to gh), or a worktree that is gone
 * (archived: nowhere to run gh). The caller turns that into one user-facing
 * sentence; a merge button must not be able to fault the host by naming a repo
 * whose state moved on under a stale panel.
 */
export function findTicketPr(store: Store, ticketId: number, repo: string): TicketPr | null {
  const row = store.db
    .prepare(
      `SELECT p.ticket_id, p.repo, p.number, p.url, p.status, p.base_ref, w.path AS cwd
         FROM prs p
         JOIN worktrees w ON w.ticket_id = p.ticket_id AND w.repo = p.repo
        WHERE p.ticket_id = ? AND p.repo = ? AND p.url IS NOT NULL
        ${CURRENT_PR_ORDER}
        LIMIT 1`,
    )
    .get(ticketId, repo) as
    | {
        ticket_id: number;
        repo: string;
        number: number | null;
        url: string;
        status: string | null;
        base_ref: string | null;
        cwd: string;
      }
    | undefined;
  if (!row) return null;
  return {
    ticketId: row.ticket_id,
    repo: row.repo,
    number: row.number,
    url: row.url,
    status: row.status,
    baseRef: row.base_ref,
    cwd: row.cwd,
  };
}

interface SyncableRow {
  ticket_id: number;
  repo: string;
  number: number | null;
  url: string;
  status: string | null;
  cwd: string;
  base_ref: string | null;
  pr_head_ref: string | null;
  pr_base_ref: string | null;
  pr_created_at: string | null;
  pr_merged_at: string | null;
  pr_comments: string | null;
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
      `SELECT p.ticket_id, p.repo, p.number, p.url, p.status, w.path AS cwd, w.base_ref,
              p.head_ref AS pr_head_ref, p.base_ref AS pr_base_ref,
              p.created_at AS pr_created_at, p.merged_at AS pr_merged_at,
              p.comments AS pr_comments
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
    baseRef: r.base_ref,
    prHeadRef: r.pr_head_ref,
    prBaseRef: r.pr_base_ref,
    prCreatedAt: r.pr_created_at,
    prMergedAt: r.pr_merged_at,
    prComments: r.pr_comments,
  }));
}
