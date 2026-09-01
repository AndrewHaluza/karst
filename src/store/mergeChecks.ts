import type { Store } from './db.js';
import { CURRENT_PR_ORDER } from './prs.js';
import type { MergeCheck, MergeState } from '../workflow/mergeCheck.js';

/**
 * The current mergeability of one ticket's branch in one repo.
 *
 * Unlike `gate_runs` and `phase_marks`, this is NOT append-only: it is current
 * state, not evidence of a past event. A merge check answers "can this land
 * today", and both refs it depends on keep moving, so an old row is not weaker
 * evidence — it is a wrong answer stated with full confidence. Re-checking
 * overwrites, and a row whose PR has landed is not read at all (`PR_NOT_MERGED`).
 */
export interface MergeCheckRow {
  ticketId: number;
  repo: string;
  state: MergeState;
  files: readonly string[];
  reason: string | null;
  headSha: string | null;
  baseSha: string | null;
  baseRef: string | null;
  checkedAt: string;
}

export interface MergeCheckInput extends MergeCheck {
  ticketId: number;
  repo: string;
  baseRef: string | null;
  checkedAt: string;
}

interface MergeCheckDbRow {
  ticket_id: number;
  repo: string;
  state: string;
  files: string;
  reason: string | null;
  head_sha: string | null;
  base_sha: string | null;
  base_ref: string | null;
  checked_at: string;
}

const STATES: readonly MergeState[] = ['clean', 'conflicted', 'unknown'];

/**
 * Parse the stored JSON path list. A value that is missing, malformed, or not an
 * array of strings yields an empty list rather than throwing: a read path runs in
 * the extension host on every dashboard refresh, and one bad row must not take
 * the panel down. Data written by this module is always well-formed; this guards
 * the boundary, not the writer.
 */
function parseFiles(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((p): p is string => typeof p === 'string');
  } catch {
    return [];
  }
}

/**
 * An unrecognised state reads as 'unknown', never as 'clean'. A row written by a
 * newer karst, or corrupted, must not be able to report a branch as mergeable.
 */
function parseState(raw: string): MergeState {
  return STATES.includes(raw as MergeState) ? (raw as MergeState) : 'unknown';
}

/**
 * Keep only the repos whose merge state is still a live question.
 *
 * A merged PR is the one state that ends the question for good, and it also ends
 * this row's ability to answer it: `syncMergeChecks` refreshes through
 * `listSyncablePrs`, which drops merged PRs on purpose (a merged PR cannot move
 * again), so the last pre-merge verdict is frozen the moment it stops being true.
 * Nothing overwrites it and nothing ever will — the dashboard went on showing
 * `conflicted · 2 files · Resolve conflicts` beside a PR row reading `merged`,
 * and the Resolve button opened a session to rebase a branch already landed.
 *
 * Filtered on READ rather than deleted when the PR merges, and both halves of
 * that matter. A delete only fires on the transition, so every row already
 * stranded in a user's DB — the ones that produced the bug report — would stay;
 * this heals them on the next refresh, and migrations may not backfill state they
 * cannot derive. It also cannot go stale itself: `prs.status` is re-probed, so the
 * answer is recomputed from current state every time it is asked.
 *
 * Absence, not a substitute verdict: a landed branch has no mergeability, and
 * every consumer already renders a missing row as nothing rather than as `clean`.
 * The repo's PR row is what states the outcome.
 *
 * Scoped to the repo's CURRENT PR (`CURRENT_PR_ORDER`, the same rule
 * `findTicketPr` applies), so a repo re-shipped after a merge — which holds both
 * the merged row and a new open one — keeps reporting for the open PR. A repo
 * with no PR at all is NOT a merged repo: `ship` records a check per worktree
 * whether or not opening the PR succeeded, and that verdict must survive.
 */
const PR_NOT_MERGED = `
    COALESCE((SELECT p.status
                FROM prs p
               WHERE p.ticket_id = merge_checks.ticket_id
                 AND p.repo = merge_checks.repo
                 AND p.url IS NOT NULL
               ${CURRENT_PR_ORDER}
               LIMIT 1), '') <> 'merged'`;

function rowToMergeCheck(r: MergeCheckDbRow): MergeCheckRow {
  return {
    ticketId: r.ticket_id,
    repo: r.repo,
    state: parseState(r.state),
    files: parseFiles(r.files),
    reason: r.reason,
    headSha: r.head_sha,
    baseSha: r.base_sha,
    baseRef: r.base_ref,
    checkedAt: r.checked_at,
  };
}

/**
 * Record the current mergeability for one (ticket, repo), replacing any previous
 * answer for that pair.
 *
 * The upsert IS the staleness guarantee: the requirement is that a stale `clean`
 * is never presented as current, and the cheapest way to keep that promise is to
 * have only one row per repo, always the newest. History would be actively
 * harmful here — a consumer scanning rows could pick the wrong one.
 *
 * Opens no transaction of its own and uses only the driver-agnostic
 * `prepare(sql).run(...)` surface with positional parameters, because the CLI
 * reaches store helpers through `node:sqlite` rather than better-sqlite3.
 */
export function setMergeCheck(store: Store, check: MergeCheckInput): void {
  store.db
    .prepare(
      `INSERT INTO merge_checks
         (ticket_id, repo, state, files, reason, head_sha, base_sha, base_ref, checked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(ticket_id, repo) DO UPDATE SET
         state      = excluded.state,
         files      = excluded.files,
         reason     = excluded.reason,
         head_sha   = excluded.head_sha,
         base_sha   = excluded.base_sha,
         base_ref   = excluded.base_ref,
         checked_at = excluded.checked_at`,
    )
    .run(
      check.ticketId,
      check.repo,
      check.state,
      JSON.stringify(check.files ?? []),
      check.reason,
      check.headSha,
      check.baseSha,
      check.baseRef,
      check.checkedAt,
    );
}

/**
 * One repo's current merge state, or null when there is none to state.
 *
 * Null is the honest answer both for "never asked" and for a repo whose PR has
 * landed (see `PR_NOT_MERGED`), and it must stay distinguishable from a recorded
 * verdict: the post-ship sweep reads this to decide whether a stored answer is
 * fresh enough to skip, and treating a missing row as `clean` would skip the very
 * repo nobody has ever probed. The sweep never reaches a merged PR anyway —
 * `listSyncablePrs` drops it before this is asked.
 */
export function getMergeCheck(store: Store, ticketId: number, repo: string): MergeCheckRow | null {
  const row = store.db
    .prepare(
      `SELECT ticket_id, repo, state, files, reason, head_sha, base_sha, base_ref, checked_at
         FROM merge_checks
        WHERE ticket_id = ? AND repo = ?
          AND ${PR_NOT_MERGED}`,
    )
    .get(ticketId, repo) as MergeCheckDbRow | undefined;
  return row ? rowToMergeCheck(row) : null;
}

/**
 * Every repo's current merge state for a ticket, ordered by repo for stable
 * rendering. Repos whose PR has landed are absent, not `clean` — see
 * `PR_NOT_MERGED`.
 */
export function listMergeChecksByTicket(store: Store, ticketId: number): MergeCheckRow[] {
  return store.db
    .prepare(
      `SELECT ticket_id, repo, state, files, reason, head_sha, base_sha, base_ref, checked_at
         FROM merge_checks
        WHERE ticket_id = ?
          AND ${PR_NOT_MERGED}
        ORDER BY repo`,
    )
    .all(ticketId)
    .map((r) => rowToMergeCheck(r as MergeCheckDbRow));
}

/**
 * Drop a repository's merge check. A base branch change invalidates it
 * completely — the recorded `base_sha`, `files` and `state` all describe a merge
 * against a base this ticket no longer targets — and a stale CLEAN check is
 * worse than no check at all.
 */
export function clearMergeCheck(store: Store, ticketId: number, repo: string): void {
  store.db.prepare('DELETE FROM merge_checks WHERE ticket_id = ? AND repo = ?').run(ticketId, repo);
}
