import type { Store } from '../store/db.js';
import type { ProjectScope } from '../store/tickets.js';
import { listSyncablePrs, updatePrStatus } from '../store/prs.js';
import { fetchPrState, defaultGhRunnerAsync, type GhRunner } from '../integrations/github.js';

/**
 * Keep the dashboard's PR statuses in step with their real upstream state.
 *
 * `ship` writes every PR as 'open' and nothing ever revised it, so a merged or
 * closed PR read 'open' forever (the bug). This re-probes each non-terminal PR
 * via gh and overwrites the stored status when it moved.
 *
 * Host-agnostic and pure over the injected `gh`: no vscode, no clock, no real
 * repo — the whole thing runs under vitest with a fake runner. The extension
 * wires it to activation and a periodic tick; here it is just a sweep.
 *
 * Graceful degradation (F4, acceptance §4): a probe that returns 'unknown' — bad
 * auth, a PR deleted upstream, a dead remote — leaves the stored status ALONE.
 * The last state we actually saw is better than a guess, and it is never counted
 * as a change, so a flaky network does not churn the dashboard. One throwing
 * probe never sinks the sweep: the rest of the PRs still get their real status.
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
    let next: string;
    try {
      next = await fetchPrState(gh, pr.url, pr.cwd);
    } catch {
      // A single probe blowing up (a runner throwing, not gh exiting nonzero)
      // must not abort the sweep — treat it exactly like 'unknown'.
      continue;
    }
    if (next === 'unknown' || next === pr.status) continue;

    updatePrStatus(store, { ticketId: pr.ticketId, repo: pr.repo, url: pr.url, status: next });
    changed += 1;
  }

  return changed;
}
