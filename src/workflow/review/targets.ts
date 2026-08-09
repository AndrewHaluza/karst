import type { Manifest } from '../../manifest/types.js';
import type { GitRunner } from '../../integrations/git.js';
import type { BlockerKind } from '../../model/types.js';
import {
  dedupeTargetsByRepoPath,
  selectReviewTargets,
  type GateTarget,
  type ReviewWorktree,
} from '../gates/targets.js';

/** One repository the review gates run against. */
export type ReviewGateTarget = GateTarget;

/**
 * What `planReviewTargets` resolved.
 *
 * `unavailable` propagates from `selectReviewTargets` verbatim: a git probe
 * failure means karst could not even determine which repositories are affected,
 * which is environmental and never a verdict about the ticket's code — the
 * caller must route it to a park.
 */
export type ReviewTargetSelection =
  | { kind: 'targets'; targets: ReviewGateTarget[]; unmapped: readonly string[] }
  | { kind: 'unavailable'; blocker: BlockerKind; reason: string };

/**
 * The repositories review runs against, built once per run.
 *
 * The affected set is `selectReviewTargets`' dependency-aware selection —
 * changing `api` can affect `web`, changing unrelated `docs` cannot — collapsed
 * to one target per repository path. Non-runnable repositories are included:
 * they are still source trees with gates, and `manifest/runnable.ts` draws the
 * boot line separately.
 *
 * Deliberately review's own function rather than a call to `planUatTargets`:
 * the two stages resolve the same thing today and must be free to diverge (a
 * findings lane will want the target's base ref), while the one rule they share
 * — the collapse — has exactly one definition, in `gates/targets.ts`.
 */
export async function planReviewTargets(
  manifest: Manifest,
  worktrees: readonly ReviewWorktree[],
  git: GitRunner,
): Promise<ReviewTargetSelection> {
  const selection = await selectReviewTargets(manifest, worktrees, git);
  if (selection.kind === 'unavailable') return selection;
  return {
    kind: 'targets',
    targets: dedupeTargetsByRepoPath(selection.targets),
    unmapped: selection.unmapped,
  };
}
