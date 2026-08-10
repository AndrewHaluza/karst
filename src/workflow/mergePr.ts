import type { Store } from '../store/db.js';
import { findTicketPr, updatePrDetail } from '../store/prs.js';
import {
  fetchPrDetail,
  mergePr,
  defaultGhRunnerAsync,
  UNKNOWN_PR_DETAIL,
  type GhRunner,
  type MergeMethod,
  type PrDetail,
  type PrStatus,
} from '../integrations/github.js';
import { settleShipGate } from './mergeGate.js';

/**
 * Merge one repo's PR for a ticket, from the ship stage, and record what actually
 * happened.
 *
 * Host-agnostic: takes the store and an injected `gh`, so it runs under vitest
 * with a fake runner and holds no vscode, no clock, no confirmation dialog. The
 * host owns the confirmation (a merge is irreversible) and the wording of the
 * toast; this owns the operation and the truth about its outcome.
 *
 * The contract that matters: **a zero exit is never taken as proof.** The stored
 * status and the returned verdict both come from a fresh `gh pr view` AFTER the
 * merge, so the UI can only show merged when the PR really is. The two honest
 * asymmetries that falls out of:
 *
 *  - gh refused but the PR reads merged (a teammate merged it, a retry after a
 *    partial failure) → success. The outcome the user asked for is true.
 *  - gh accepted but the PR does not read merged (a queued/blocked merge, a
 *    probe that cannot see it) → NOT success, with the state named. Silence here
 *    is what would let the panel lie about an irreversible action.
 */
export interface MergeTicketPrOpts {
  ticketId: number;
  /** The repository the PR belongs to (a repo path, as `prs.repo` stores it). */
  repo: string;
  /** How to merge. Always explicit — the host asks the user which. */
  method: MergeMethod;
  /**
   * Verbose decision-point logging (§ debug logging), prefixed `[merge]`,
   * threaded into the post-merge settlement. Absent → no debug lines; the
   * host binds it to `Logger.debug` (a no-op unless the manifest's `debug`
   * flag is on).
   */
  debug?: (message: string) => void;
}

export interface MergeTicketPrResult {
  /** True only when the PR is confirmed merged afterwards. */
  ok: boolean;
  /**
   * True when this merge was the LAST one outstanding and the ticket therefore
   * advanced from `ship` to `done`. False on a multi-repo ticket with PRs still
   * open — the ticket stays parked at `ship`, blocked on the rest.
   *
   * Reported rather than left for the caller to re-derive, so the post-merge
   * provider status push fires exactly once, on the call that actually finished
   * the ticket.
   */
  completedTicket: boolean;
  /**
   * The PR's status as it now stands: the re-probed value when gh could see it,
   * else the last stored one. Null only when there was no PR to act on at all.
   */
  status: PrStatus | string | null;
  /** Why it did not merge, in gh's own words where there are any; '' on success. */
  reason: string;
}

/** A probe must never sink the operation it observes: failure reads as unknown. */
async function probe(gh: GhRunner, url: string, cwd: string): Promise<PrDetail> {
  try {
    return await fetchPrDetail(gh, url, cwd);
  } catch {
    return UNKNOWN_PR_DETAIL;
  }
}

/**
 * Let the merge gate re-read the ticket now that this PR has landed.
 *
 * Swallows, deliberately: the merge is done and undoable by nobody, so a
 * bookkeeping failure must not be reported as a failed merge. The gate is
 * idempotent and the background sweep runs it again on the next tick, so the
 * ticket still reaches `done` — just later.
 */
function settle(store: Store, ticketId: number, debug?: (message: string) => void): boolean {
  try {
    return settleShipGate(store, ticketId, debug).advanced;
  } catch {
    return false;
  }
}

export async function mergeTicketPr(
  store: Store,
  opts: MergeTicketPrOpts,
  gh: GhRunner = defaultGhRunnerAsync,
): Promise<MergeTicketPrResult> {
  // The store decides what is mergeable, not the caller: the repo arrives from a
  // webview message and a stale panel can name a PR that has since gone.
  const pr = findTicketPr(store, opts.ticketId, opts.repo);
  if (!pr) {
    return {
      ok: false,
      status: null,
      completedTicket: false,
      reason: `No pull request is recorded for "${opts.repo}" on this ticket — nothing to merge.`,
    };
  }
  // Already merged: the desired state, reached earlier. Not an error, and not a
  // reason to run an irreversible command a second time. Still settles: the
  // ticket can still be blocked at `ship` because a DIFFERENT repo was the
  // holdout, and a click on the landed one is as good a moment as any to notice
  // it has caught up.
  if (pr.status === 'merged') {
    return { ok: true, status: 'merged', completedTicket: settle(store, opts.ticketId, opts.debug), reason: '' };
  }

  const attempt = await mergePr(gh, pr.url, pr.cwd, opts.method);
  const detail = await probe(gh, pr.url, pr.cwd);
  // Persist whatever the probe could see, pass or fail: a refused merge still
  // brings back the comments and status that explain the refusal, and
  // `updatePrDetail` drops an unknown status rather than overwriting a real one.
  updatePrDetail(store, { ticketId: pr.ticketId, repo: pr.repo, url: pr.url, detail });

  const status = detail.status === 'unknown' ? pr.status : detail.status;
  if (detail.status === 'merged') {
    return { ok: true, status: 'merged', completedTicket: settle(store, opts.ticketId, opts.debug), reason: '' };
  }
  if (!attempt.ok) return { ok: false, status, completedTicket: false, reason: attempt.reason };
  return {
    ok: false,
    status,
    completedTicket: false,
    reason:
      detail.status === 'unknown'
        ? 'gh reported the merge succeeded, but karst could not confirm it on GitHub. Check the pull request before retrying.'
        : `gh reported the merge succeeded, but the pull request still reads ${detail.status}.`,
  };
}
