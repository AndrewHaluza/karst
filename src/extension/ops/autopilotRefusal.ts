import { shortSha } from '../../model/inside/deliver.js';
import type { RoundRefusal } from './autoDeliverOps.js';

/**
 * The parks of a conflict round that ended without a delivery (@arch:AP-01, T1315).
 *
 * Two outcomes looked the same before T1315 and must not: a merge the agent left unfinished, and a merge that PASSED the
 * merge check and was stopped only by a gate or the base check. The first is a round that never delivered (the stall path);
 * the second is a merge commit that is ready in the worktree, so the park names the gate and the manual Deliver pushes it.
 * The agent is already idle after either, so nothing retries the delivery: both parks hold until a person acts or every
 * PR is proven clean.
 */

/** An armed round that never delivered: the agent left the merge unfinished, or the reload killed it. */
export const STALLED_REASON = 'auto-fix stopped: conflict round did not deliver';

/** The body of a round that never delivered. */
export const UNFINISHED_BODY = 'the resolved merge was not delivered (the agent left it unfinished, or a gate failed). The round is dropped; approve one more attempt or resolve the conflict by hand.';

const REFUSED_PREFIX = 'auto-fix stopped: resolved merge not delivered:';

/** The park reason of a refused delivery of a verified merge: `auto-fix stopped: resolved merge not delivered: gate <name> failed`. */
export const refusedMergeReason = (tail: string): string => `${REFUSED_PREFIX} ${tail}`;

/** The body of that park: the merge commit is in the worktree and the manual Deliver pushes it. */
export function refusedMergeBody(r: RoundRefusal): string {
  const merge = r.sha === null ? 'the resolved merge' : `the merge commit ${shortSha(r.sha)}`;
  return `${merge} is ready in the worktree of ${r.repo} and the manual Deliver pushes it. The round is dropped, so nothing retries the delivery.`;
}

/** A park that holds until a person acts or every PR is proven clean: the round is gone and nothing retries it. */
export function holdsPark(reason: string | null): boolean {
  return reason !== null && (reason === STALLED_REASON || reason.startsWith(REFUSED_PREFIX));
}
