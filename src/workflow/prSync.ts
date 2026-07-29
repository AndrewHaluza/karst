import type { Store } from '../store/db.js';
import type { ProjectScope } from '../store/tickets.js';
import { listSyncablePrs, updatePrDetail, type SyncablePr } from '../store/prs.js';
import { fetchPrDetail, defaultGhRunnerAsync, type GhRunner, type PrDetail } from '../integrations/github.js';
import { serializeComments } from '../model/prComments.js';

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
export async function syncPrStatuses(
  store: Store,
  gh: GhRunner = defaultGhRunnerAsync,
  scope: ProjectScope = {},
): Promise<number> {
  const prs = listSyncablePrs(store, scope);
  let changed = 0;

  for (const pr of prs) {
    let detail: PrDetail;
    try {
      detail = await fetchPrDetail(gh, pr.url, pr.cwd);
    } catch {
      // A single probe blowing up (a runner throwing, not gh exiting nonzero)
      // must not abort the sweep — treat it exactly like the unknown detail.
      continue;
    }
    // A probe that stated nothing new — including the all-unknown detail of a
    // failed probe — writes nothing and counts as nothing.
    if (!prDetailChanged(pr, detail)) continue;

    updatePrDetail(store, { ticketId: pr.ticketId, repo: pr.repo, url: pr.url, detail });
    changed += 1;
  }

  return changed;
}
