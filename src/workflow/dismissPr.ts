import type { Store } from '../store/db.js';
import { dismissPr, undismissPr, listCurrentPrsByTicket } from '../store/prs.js';
import { settleShipGate } from './mergeGate.js';

/**
 * The escape hatch for a ticket parked at `ship` behind a pull request that was
 * CLOSED rather than merged — the changes turned out to be unneeded.
 *
 * The merge gate waits for a literal `'merged'` per repo, and a closed PR can
 * never reach it: on a three-repo ticket with two merged and one closed, nothing
 * karst, gh or the background sweep does will ever produce an answer, and the
 * ticket sits at `ship` forever with no action that can move it. Dismissing is
 * the human statement the gate is missing — "this one is not coming" — and it is
 * a statement about a PR, never a force-advance of the ticket: the gate is then
 * re-read normally, so a ticket with other unmerged PRs stays exactly as parked
 * as it was.
 *
 * Host-agnostic (store + an injected stamp, no clock, no vscode, no gh) and
 * reversible: `undismissTicketPr` puts the PR back in the gate's way, which is
 * what a PR reopened upstream — or a mis-click — needs.
 */
export interface DismissTicketPrOpts {
  ticketId: number;
  /** The repository whose PR is being dismissed (a `prs.repo` value). */
  repo: string;
  /** The dismissal stamp, injected by the host. */
  at: string;
  /** `[merge]`-prefixed decision logging, threaded into the settlement. */
  debug?: (message: string) => void;
}

export interface DismissTicketPrResult {
  /** True when the PR is now dismissed (or un-dismissed, for the undo). */
  ok: boolean;
  /** True only when this call was what let the ticket reach `done`. */
  completedTicket: boolean;
  /** Why it did not apply, in words the panel can show; '' on success. */
  reason: string;
}

/** Why this repo cannot be dismissed, or '' when it can. */
function refusal(store: Store, ticketId: number, repo: string): string {
  const pr = listCurrentPrsByTicket(store, ticketId).find((p) => p.repo === repo);
  if (pr === undefined) {
    return `No pull request is recorded for "${repo}" on this ticket — nothing to dismiss.`;
  }
  if (pr.status === 'merged') {
    return `The pull request for "${repo}" is merged — it landed, so there is nothing to dismiss.`;
  }
  return '';
}

export function dismissTicketPr(
  store: Store,
  opts: DismissTicketPrOpts,
): DismissTicketPrResult {
  // The store decides what is dismissable, not the caller: the repo arrives from
  // a webview message and a stale panel can name a PR that has since moved on.
  const reason = refusal(store, opts.ticketId, opts.repo);
  if (reason !== '') {
    opts.debug?.(
      `[merge] ticket ${opts.ticketId}: dismiss refused for '${opts.repo}' — ${reason}`,
    );
    return { ok: false, completedTicket: false, reason };
  }
  if (!dismissPr(store, { ticketId: opts.ticketId, repo: opts.repo, at: opts.at })) {
    return { ok: false, completedTicket: false, reason: refusal(store, opts.ticketId, opts.repo) };
  }
  opts.debug?.(
    `[merge] ticket ${opts.ticketId}: dismissed the pull request for '${opts.repo}' — re-settling the gate`,
  );
  return { ok: true, completedTicket: settle(store, opts.ticketId, opts.debug), reason: '' };
}

/**
 * Put a dismissed PR back in the gate's way.
 *
 * Never un-lands a ticket that already reached `done` on the dismissal: stages
 * move forward through `transition`, and reversing one is `sendBack`'s business,
 * not a bookkeeping undo's. What this restores is the PR's own standing, so the
 * NEXT settlement (a re-ship, a send-back to ship) sees it again.
 */
export function undismissTicketPr(
  store: Store,
  opts: { ticketId: number; repo: string; debug?: (message: string) => void },
): DismissTicketPrResult {
  if (!undismissPr(store, { ticketId: opts.ticketId, repo: opts.repo })) {
    return {
      ok: false,
      completedTicket: false,
      reason: `No pull request is recorded for "${opts.repo}" on this ticket.`,
    };
  }
  opts.debug?.(
    `[merge] ticket ${opts.ticketId}: un-dismissed the pull request for '${opts.repo}'`,
  );
  return { ok: true, completedTicket: false, reason: '' };
}

/**
 * Re-read the gate now that a PR left it. Swallows, deliberately, for the same
 * reason `mergePr.ts` does: the dismissal is recorded and true regardless, and a
 * bookkeeping failure must not be reported as a refused dismissal. The gate is
 * idempotent and the background sweep runs it again on the next tick.
 */
function settle(store: Store, ticketId: number, debug?: (message: string) => void): boolean {
  try {
    return settleShipGate(store, ticketId, debug).advanced;
  } catch {
    return false;
  }
}
