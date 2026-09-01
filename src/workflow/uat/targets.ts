import type { Manifest } from '../../manifest/types.js';
import type { Store } from '../../store/db.js';
import type { GitRunner } from '../../integrations/git.js';
import type { BlockerKind } from '../../model/types.js';
import {
  dedupeTargetsByRepoPath,
  selectReviewTargets,
  type GateTarget,
  type ReviewWorktree,
} from '../gates/targets.js';

/** One repository UAT runs its gates against. */
export type UatTarget = GateTarget;

/**
 * What `planUatTargets` resolved — mirrors `TargetSelection` (`gates/targets.ts`)
 * over `UatTarget` rather than `ReviewTarget`, since it re-derives the plan by
 * repoPath rather than passing the review shape straight through. `unavailable`
 * propagates from `selectReviewTargets` verbatim: a git probe failure means
 * karst could not even determine which repositories are affected, which is not
 * a different question for UAT than it is for review.
 */
export type UatTargetSelection =
  | { kind: 'targets'; targets: UatTarget[]; unmapped: readonly string[] }
  | { kind: 'unavailable'; blocker: BlockerKind; reason: string };

/**
 * The repositories UAT runs against, built once per run.
 *
 * Reuses review's dependency-aware affected-target selection rather than a second
 * implementation: changing `api` can affect `web`, changing unrelated `docs`
 * cannot, and that propagation rule should have exactly one definition.
 *
 * Deduplicated by `repo` (the repoPath), because two `repositories:` entries
 * sharing a path are one monorepo with one worktree — running `npm test` twice
 * in the same directory answers the same question twice. This also protects
 * against a duplicated `worktrees` row for the same path (stale data, a
 * double-write): every name that maps to the path is preserved and merged,
 * never dropped, because service identity stays keyed by repository NAME
 * (distinct ports, distinct `servers` rows) and per-repository gate overrides
 * in `declaredGatesFor` are keyed by that same name.
 *
 * Non-runnable repositories are included: they are still source trees with
 * suites, and `manifest/runnable.ts` draws the boot line separately.
 */
export async function planUatTargets(
  manifest: Manifest,
  worktrees: readonly ReviewWorktree[],
  git: GitRunner,
  /**
   * Required, not optional: each target is diffed against the base its worktree
   * was CUT from (`worktrees.base_ref`), not the manifest default. Making the
   * caller supply the ticket is what stops a gate silently diffing against a
   * base this ticket never used.
   */
  ticket: { store: Store; ticketId: number },
  debug?: (message: string) => void,
): Promise<UatTargetSelection> {
  const selection = await selectReviewTargets(manifest, worktrees, git, {
    store: ticket.store,
    ticketId: ticket.ticketId,
    debug,
  });
  if (selection.kind === 'unavailable') {
    debug?.(
      `[gate] uat targets ticket ${ticket.ticketId}: unavailable (${selection.blocker}: ${selection.reason})`,
    );
    return selection;
  }
  debug?.(
    `[gate] uat targets ticket ${ticket.ticketId}: ${selection.targets.length} target(s) after dedupe`,
  );
  return {
    kind: 'targets',
    targets: dedupeTargetsByRepoPath(selection.targets),
    unmapped: selection.unmapped,
  };
}
