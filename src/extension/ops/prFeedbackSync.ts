import { defaultGhRunnerAsync, type GhRunner } from '../../integrations/github.js';
import { fetchPrReviewState, type PrRef } from '../../integrations/githubReview.js';
import type { SyncPrFeedbackDeps } from '../../workflow/prSync.js';

/**
 * The host's PR-feedback dependency bundle for `syncPrStatuses`.
 *
 * Lives under ops/ rather than in extension.ts because that file is line-capped
 * (ops/ratchet.test.ts) — and because assembling it here keeps it unit-testable
 * with a fake runner and no vscode.
 */
export function makePrFeedbackDeps(
  debug: (message: string) => void,
  gh: GhRunner = defaultGhRunnerAsync,
): SyncPrFeedbackDeps {
  return {
    debug,
    fetchFeedback: (ref: PrRef, cwd: string) => fetchPrReviewState(gh, ref, cwd, debug),
  };
}
