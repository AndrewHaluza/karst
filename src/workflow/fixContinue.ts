import type { Store } from '../store/db.js';
import { FIX_CONTINUED_PREFIX } from '../model/noChange.js';
import type { RecoveryRound } from '../store/recoveryRoundsRead.js';
import { sameHeadStreak } from '../store/fixNoChangeRounds.js';
import { continueFixRound, parkFixStage } from '../store/recoveryRoundsWrite.js';
import { fixAttemptsRemain } from './fixAttempts.js';

/**
 * The most fix rounds in a row that may end on one head before a continued gate-failure round
 * parks for the user (T1330). It is the value `review.stallDetection.sameFileRounds` gives "a lot
 * of times", and it is a constant: a setting would need the manifest, the settings page and the
 * baselines.
 */
export const FIX_SAME_HEAD_LIMIT = 5;

/** `end_reason` bound of a continued round, the same 200 characters `noChangeEndReason` uses. */
const FIX_CONTINUED_MAX_CHARS = 200;

export interface ContinueOrParkOptions {
  /** What the failed gates said; it follows `FIX_CONTINUED_PREFIX` in `end_reason`. */
  detail: string;
  /** The existing host-park lead text; `fixParkReason` matches its prefixes. */
  parkVerdict: string;
  at: string;
}

export type ContinueOrParkOutcome =
  | { kind: 'continued'; round: RecoveryRound }
  | { kind: 'parked'; verdict: string };

/**
 * Park the fix stage and move the round out of `pending`/`fixing`, in one transaction. `pending`
 * is included because a marker can arrive on a round whose execution never attached: the park must
 * never leave a round the driver would resume under a failed fix row.
 */
export function parkRound(store: Store, ticketId: number, roundId: number, verdict: string, at: string): void {
  store.db.transaction(() => {
    parkFixStage(store, ticketId, verdict, at);
    store.db
      .prepare(
        `UPDATE recovery_rounds SET status = 'interrupted', end_reason = ?, ended_at = ?
          WHERE id = ? AND status IN ('pending','fixing')`,
      )
      .run(verdict, at, roundId);
  })();
}

/**
 * Open the next fix round for a gate that still fails, or park the ticket for the user (T1330).
 * The round parks only when nothing else can verify the head: the committed budget has no round
 * left (`fixAttemptsRemain`; a pending round AT the cap is marked `exhausted` by the driver with no
 * fix and no park, so it is never opened), the loop limit on one head is reached, or the source
 * stage is not uat/review. The park verdict starts with the caller's existing lead text and ends
 * with the cause. Otherwise the round closes `failed` with `gates still fail: <detail>` and the
 * next round of the same episode opens.
 */
export function continueOrPark(
  store: Store,
  round: RecoveryRound,
  opts: ContinueOrParkOptions,
): ContinueOrParkOutcome {
  const spent = !fixAttemptsRemain(round.round + 1, round.maxRounds);
  const streak = spent ? 0 : sameHeadStreak(store, round);
  const cause = spent
    ? `the fix rounds are spent (round ${round.round} of ${round.maxRounds})`
    : streak >= FIX_SAME_HEAD_LIMIT
      ? `${streak} rounds in a row changed nothing on the same head`
      : round.sourceStage !== 'uat' && round.sourceStage !== 'review'
        ? `the fix round cannot continue from the ${round.sourceStage} stage`
        : null;
  if (cause !== null) {
    const verdict = `${opts.parkVerdict} — ${cause}`;
    parkRound(store, round.ticketId, round.id, verdict, opts.at);
    return { kind: 'parked', verdict };
  }
  const endReason = `${FIX_CONTINUED_PREFIX} ${opts.detail}`.slice(0, FIX_CONTINUED_MAX_CHARS);
  const next = continueFixRound(store, { roundId: round.id, endReason, at: opts.at });
  if (next === null) {
    // The committed budget refused the new round after all: park rather than leave a spent round
    // under a running fix row.
    const verdict = `${opts.parkVerdict} — the next fix round did not open (round ${round.round} of ${round.maxRounds}; the round status changed during the re-run or the budget is spent)`;
    parkRound(store, round.ticketId, round.id, verdict, opts.at);
    return { kind: 'parked', verdict };
  }
  return { kind: 'continued', round: next };
}
