import type { Store } from '../store/db.js';
import type { GitRunner } from '../integrations/git.js';
import { nowIso } from '../model/time.js';
import { noChangeEndReason, NO_CHANGE_RERUN_REQUESTED_REPLY } from '../model/noChange.js';
import { activeFixRound } from '../store/recoveryRounds.js';
import { listGateRuns } from '../store/gateRuns.js';
import { listFixRoundHeads, type FixRoundHead } from '../store/fixRoundHeads.js';
import { previousNoChangeRound, recordNoChangeReason, requestNoChangeRerun } from '../store/fixNoChangeRounds.js';
import { parkRoundOutOfFixing } from '../store/hostRerunRound.js';
import { parkFixStage } from '../store/recoveryRoundsWrite.js';
import { fixRoundHasNewCommit } from './fixRoundGuard.js';
import { HOST_RERUN_WAY_OUT, failedGatesOf } from './fixHostRerun.js';

/** What the no-change marker decided. `proceed` means the normal marker runs next. */
export type NoChangeOutcome =
  | { kind: 'not-applicable' }
  | { kind: 'proceed' }
  | { kind: 'rerun-requested'; message: string }
  | { kind: 'rerun-via-bridge' }
  | { kind: 'refused'; message: string };

const ALREADY_RECORDED = 'this fix round already has a no-change verdict — stop and wait for the host';

/** Leading text of the same-head park verdict; the agent reason and the way out follow it. */
export const NO_CHANGE_SAME_HEAD_PREFIX = 'second no-change verdict on the same head';

/** The park verdict of a second no-change on the same head. */
export const NO_CHANGE_SAME_HEAD_VERDICT = (reason: string): string =>
  `${NO_CHANGE_SAME_HEAD_PREFIX} (${noChangeEndReason(reason)}) — ${HOST_RERUN_WAY_OUT}`;

/** Equal as sets of `path:sha`. Two empty sets are NOT equal: no snapshot is no evidence. */
function sameHeads(a: readonly FixRoundHead[], b: readonly FixRoundHead[]): boolean {
  if (a.length === 0 || a.length !== b.length) return false;
  const key = (h: FixRoundHead): string => `${h.worktreePath}\u0000${h.headSha}`;
  const set = new Set(a.map(key));
  return b.every((h) => set.has(key(h)));
}

/**
 * Decide a `stage fix pass --no-change <reason>` marker (@arch:AC-66). A new commit makes the
 * flag moot. Otherwise the reason is stored once. A gate-failure round asks for the host re-run
 * of its failed gates. A review or tester round takes the normal marker. A second no-change on
 * the same head parks the fix stage.
 */
export async function applyNoChangeMarker(
  store: Store,
  ticketId: number,
  reason: string,
  git: GitRunner,
  options: { viaBridge: boolean; now?: () => string },
): Promise<NoChangeOutcome> {
  const now = options.now ?? nowIso;
  const round = activeFixRound(store, ticketId);
  if (round === null) return { kind: 'not-applicable' };
  if (await fixRoundHasNewCommit(store, ticketId, git)) return { kind: 'not-applicable' };
  // A repeat in the same round (a retry after a probe refusal or a lost bridge reply) keeps the first
  // reason and repeats the decision. The re-run claim stays single.
  // A gate-failure round with no failed gate rows has nothing to re-run: the normal guard runs.
  if (round.triggerKind === 'gate-failure' && failedGatesOf(listGateRuns(store, ticketId), round.sourceStage).length === 0) return { kind: 'not-applicable' };
  const repeat = round.noChangeReason !== null;
  const prev = repeat ? null : previousNoChangeRound(store, ticketId, round.sourceStage, round.id);
  if (prev !== null && sameHeads(listFixRoundHeads(store, prev.id), listFixRoundHeads(store, round.id))) {
    const verdict = NO_CHANGE_SAME_HEAD_VERDICT(reason);
    store.db.transaction(() => {
      recordNoChangeReason(store, round.id, reason, now());
      parkFixStage(store, ticketId, verdict, now());
      parkRoundOutOfFixing(store, round.id, verdict, now());
    })();
    return { kind: 'refused', message: verdict };
  }
  if (!repeat && !recordNoChangeReason(store, round.id, reason, now())) return { kind: 'refused', message: ALREADY_RECORDED };
  if (round.triggerKind !== 'gate-failure') return { kind: 'proceed' };
  if (options.viaBridge) return { kind: 'rerun-via-bridge' };
  // Only the host CLI path asks the sweep. The bridge path re-runs the gates itself.
  requestNoChangeRerun(store, round.id, now());
  return { kind: 'rerun-requested', message: NO_CHANGE_RERUN_REQUESTED_REPLY };
}
