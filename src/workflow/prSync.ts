import type { Store } from '../store/db.js';
import type { ProjectScope } from '../store/tickets.js';
import { listSyncablePrs, updatePrDetail, type SyncablePr } from '../store/prs.js';
import { fetchPrDetail, defaultGhRunnerAsync, type GhRunner, type PrDetail } from '../integrations/github.js';
import { serializeComments } from '../model/prComments.js';
import { nowIso } from '../model/time.js';
import { parsePrRef, type PrRef, type PrFeedbackProbe } from '../integrations/githubReview.js';
import { reconcilePrFeedback } from '../store/prFeedback.js';

/**
 * Whether a probe actually moved anything on this row.
 *
 * Only fields the probe STATED count: a null it did not answer for is not a
 * change (the store keeps the stored value), so a degraded gh cannot make the
 * sweep report churn. Comments compare as their serialized text — the same form
 * the column holds — which is cheaper than parsing to compare.
 */
export function prDetailChanged(stored: SyncablePr, detail: PrDetail): boolean {
  if (detail.status !== 'unknown' && detail.status !== stored.status) return true;
  if (detail.headRef !== null && detail.headRef !== stored.prHeadRef) return true;
  if (detail.baseRef !== null && detail.baseRef !== stored.prBaseRef) return true;
  if (detail.createdAt !== null && detail.createdAt !== stored.prCreatedAt) return true;
  if (detail.mergedAt !== null && detail.mergedAt !== stored.prMergedAt) return true;
  const comments = serializeComments(detail.comments);
  return comments !== null && comments !== stored.prComments;
}

/**
 * Keep the dashboard's PR rows in step with their real upstream state.
 *
 * `ship` writes every PR as 'open' and nothing ever revised it, so a merged or
 * closed PR read 'open' forever (the bug). This re-probes each non-terminal PR
 * via gh and overwrites what moved — the status AND the metadata the ship stage
 * renders beside it (from-to branches, opened/merged stamps, comments), all from
 * one `gh pr view` per PR.
 *
 * Host-agnostic and pure over the injected `gh`: no vscode, no clock, no real
 * repo — the whole thing runs under vitest with a fake runner. The extension
 * wires it to activation and a periodic tick; here it is just a sweep.
 *
 * Graceful degradation (F4, acceptance §4): a probe that could not see the PR
 * returns the all-unknown detail and NOTHING is written — the last state we
 * actually saw is better than a guess. The same rule holds per field: an answer
 * missing a branch or a date leaves the stored one alone (`updatePrDetail`), so a
 * partial answer never reads as a correction to null. One throwing probe never
 * sinks the sweep: the rest of the PRs still get their real state.
 *
 * Returns how many rows changed, so the caller can skip a dashboard refresh when
 * nothing moved.
 */
export interface SyncPrFeedbackDeps {
  /** Absent = feedback is not refreshed at all. Injected so the sweep is testable without gh. */
  fetchFeedback?: (ref: PrRef, cwd: string) => Promise<PrFeedbackProbe | null>;
  now?: () => string;
  /** '[merge]'-prefixed decision logging. */
  debug?: (message: string) => void;
}

export async function syncPrStatuses(
  store: Store,
  gh: GhRunner = defaultGhRunnerAsync,
  scope: ProjectScope = {},
  deps: SyncPrFeedbackDeps = {},
): Promise<number> {
  const prs = listSyncablePrs(store, scope);
  let changed = 0;

  for (const pr of prs) {
    let detail: PrDetail | null = null;
    try {
      detail = await fetchPrDetail(gh, pr.url, pr.cwd);
    } catch {
      // A single probe blowing up (a runner throwing, not gh exiting nonzero)
      // must not skip this PR's FEEDBACK too — the detail is simply unknown.
      deps.debug?.(
        `[merge] pr detail probe threw for ticket ${pr.ticketId} ${pr.repo} — detail left as stored`,
      );
    }
    // A probe that stated nothing new — including the all-unknown detail of a
    // failed probe — writes nothing and counts as nothing.
    if (detail && prDetailChanged(pr, detail)) {
      updatePrDetail(store, { ticketId: pr.ticketId, repo: pr.repo, url: pr.url, detail });
      changed += 1;
    }

    if (deps.fetchFeedback) {
      const ref = parsePrRef(pr.url);
      if (ref) {
        try {
          const got = await deps.fetchFeedback(ref, pr.cwd);
          if (got) {
            // A truncated threads/reviews list is an INCOMPLETE set, so it must
            // not be treated as authoritative for absence: rows it did not carry
            // were unread, not withdrawn. Comment-list truncation does not drop a
            // thread from the set, so only the two set-sized cuts gate this.
            const authoritative = !(got.truncated.threads || got.truncated.reviews);
            const r = reconcilePrFeedback(store, {
              ticketId: pr.ticketId,
              repo: pr.repo,
              prUrl: pr.url,
              snapshot: got.snapshot,
              at: (deps.now ?? nowIso)(),
              markAbsent: authoritative,
              debug: deps.debug,
            });
            if (r.inserted || r.updated || r.markedAbsent || r.reappeared) changed += 1;
            if (
              got.truncated.threads ||
              got.truncated.reviews ||
              got.truncated.threadComments.length > 0
            ) {
              deps.debug?.(
                `[merge] pr feedback for ticket ${pr.ticketId} ${pr.repo} was TRUNCATED ` +
                  `(threads=${got.truncated.threads} reviews=${got.truncated.reviews} ` +
                  `threadComments=${got.truncated.threadComments.length}) — some feedback was not read`,
              );
            }
          }
        } catch (e) {
          deps.debug?.(
            `[merge] pr feedback probe failed for ticket ${pr.ticketId} ${pr.repo}: ` +
              `${e instanceof Error ? e.message : String(e)} — nothing written`,
          );
        }
      }
    }
  }

  return changed;
}
