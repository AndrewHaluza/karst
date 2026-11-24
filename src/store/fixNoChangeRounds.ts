import type { Store } from './db.js';
import { FIX_CONTINUED_PREFIX } from '../model/noChange.js';
import { activeFixRound, ROUND_SELECT, rowToRound, type RecoveryRound, type RecoveryRoundRow } from './recoveryRoundsRead.js';
import { listFixRoundHeads, sameHeads } from './fixRoundHeads.js';

type SourceStage = RecoveryRound['sourceStage'];

/** Store the agent's no-change reason on a round that is still in fix. Once per round. */
export function recordNoChangeReason(store: Store, roundId: number, reason: string, at: string): boolean {
  return Number(
    store.db
      .prepare("UPDATE recovery_rounds SET no_change_reason = ?, no_change_at = ? WHERE id = ? AND no_change_reason IS NULL AND status IN ('pending','fixing')")
      .run(reason, at, roundId).changes,
  ) === 1;
}

/**
 * The one host re-run a no-change verdict buys. It is separate from the D403 claim. The owner pid
 * goes in `host_rerun_pid`: one re-run is in flight per round, so the D403 claim does not share it.
 */
export function claimNoChangeRerun(store: Store, roundId: number, at: string, ownerPid: number = process.pid): boolean {
  return Number(
    store.db
      .prepare('UPDATE recovery_rounds SET no_change_rerun_at = ?, host_rerun_pid = ? WHERE id = ? AND no_change_reason IS NOT NULL AND no_change_rerun_at IS NULL')
      .run(at, ownerPid, roundId).changes,
  ) === 1;
}

/** Stamp the host CLI request for the sweep re-run. The bridge path never writes it. */
export function requestNoChangeRerun(store: Store, roundId: number, at: string): boolean {
  return Number(
    store.db
      .prepare('UPDATE recovery_rounds SET no_change_rerun_requested_at = ? WHERE id = ? AND no_change_rerun_requested_at IS NULL')
      .run(at, roundId).changes,
  ) === 1;
}

/** Tickets of one project with a fixing gate-failure round that the host CLI asked to re-run and that has no claim. */
export function ticketsWithRequestedNoChangeRerun(store: Store, projectId: number): number[] {
  const rows = store.db
    .prepare(
      `SELECT DISTINCT r.ticket_id AS id FROM recovery_rounds r JOIN tickets t ON t.id = r.ticket_id
        WHERE t.project_id = ? AND r.status = 'fixing' AND r.trigger_kind = 'gate-failure'
          AND r.no_change_rerun_requested_at IS NOT NULL AND r.no_change_rerun_at IS NULL`,
    )
    .all(projectId) as { id: number }[];
  return rows.map((r) => r.id);
}

/** The most recent earlier round of the same ticket and source stage that has a no-change reason. */
export function previousNoChangeRound(store: Store, ticketId: number, sourceStage: SourceStage, beforeRoundId: number): RecoveryRound | null {
  const row = store.db
    .prepare(`${ROUND_SELECT} WHERE ticket_id = ? AND source_stage = ? AND id < ? AND no_change_reason IS NOT NULL ORDER BY id DESC LIMIT 1`)
    .get(ticketId, sourceStage, beforeRoundId) as RecoveryRoundRow | undefined;
  return row === undefined ? null : rowToRound(row);
}

export function latestRound(store: Store, ticketId: number): RecoveryRound | null {
  const row = store.db
    .prepare(`${ROUND_SELECT} WHERE ticket_id = ? ORDER BY id DESC LIMIT 1`)
    .get(ticketId) as RecoveryRoundRow | undefined;
  return row === undefined ? null : rowToRound(row);
}

/**
 * How many rounds in a row ended on the SAME head — the loop limit for a continued gate-failure
 * round (T1330, `FIX_SAME_HEAD_LIMIT`). It counts the given round, then each earlier round of the
 * same ticket, source stage and episode while it is a `failed` `gate-failure` round whose recorded
 * HEADs equal the given round's as a set. The first round that does not match stops the count, so a
 * commit (different HEADs) and a user Retry (the parked round is `interrupted`) both restart it. A
 * round with no recorded HEADs is no evidence of a loop: it counts as 1.
 */
export function sameHeadStreak(store: Store, round: RecoveryRound): number {
  const own = listFixRoundHeads(store, round.id);
  if (own.length === 0) return 1;
  const rows = store.db
    .prepare(
      `${ROUND_SELECT} WHERE ticket_id = ? AND source_stage = ? AND episode = ? AND id <= ?
        ORDER BY id DESC`,
    )
    .all(round.ticketId, round.sourceStage, round.episode, round.id) as RecoveryRoundRow[];
  let streak = 1;
  for (const row of rows) {
    if (row.id === round.id) continue;
    const earlier = rowToRound(row);
    if (earlier.triggerKind !== 'gate-failure' || earlier.status !== 'failed') break;
    if (!sameHeads(listFixRoundHeads(store, earlier.id), own)) break;
    streak += 1;
  }
  return streak;
}

/** The round just before the active fix round that the host continued, and the agent's reason. */
export interface ContinuedRound {
  round: RecoveryRound;
  /** The earlier round's stored agent reason; null for a no-commit round. Never its `end_reason`. */
  reason: string | null;
}

/**
 * The round just before the ticket's active fix round (same source stage and episode) when the
 * host closed it because the source stage still failed (`FIX_CONTINUED_PREFIX`), with the agent's
 * stored reason. Null for the first round of an episode, or when the previous round closed for
 * another cause. The brief of the continued round reads this (`continuedFrom`).
 */
export function previousContinuedRound(store: Store, ticketId: number): ContinuedRound | null {
  const active = activeFixRound(store, ticketId);
  if (active === null) return null;
  const row = store.db
    .prepare(
      `${ROUND_SELECT} WHERE ticket_id = ? AND source_stage = ? AND episode = ? AND id < ?
        ORDER BY id DESC LIMIT 1`,
    )
    .get(ticketId, active.sourceStage, active.episode, active.id) as RecoveryRoundRow | undefined;
  if (row === undefined) return null;
  const end = store.db.prepare('SELECT end_reason FROM recovery_rounds WHERE id = ?').get(row.id) as
    | { end_reason: string | null }
    | undefined;
  if (end?.end_reason == null || !end.end_reason.startsWith(FIX_CONTINUED_PREFIX)) return null;
  const previous = rowToRound(row);
  return { round: previous, reason: previous.noChangeReason };
}

/**
 * The round a parked fix stage rests on, or null (@arch:AC-66). The ticket is at fix, the fix row is
 * failed with no blocker kind, and the latest round is interrupted with a uat or review source.
 */
export function parkedFixRound(store: Store, ticketId: number): RecoveryRound | null {
  const t = store.db
    .prepare("SELECT t.stage_current AS cur, s.status AS st, s.blocked_kind AS bk FROM tickets t LEFT JOIN stages s ON s.ticket_id = t.id AND s.stage_key = 'fix' WHERE t.id = ?")
    .get(ticketId) as { cur: string | null; st: string | null; bk: string | null } | undefined;
  if (t === undefined || t.cur !== 'fix' || t.st !== 'failed' || t.bk !== null) return null;
  const round = latestRound(store, ticketId);
  if (round === null || round.status !== 'interrupted') return null;
  return round.sourceStage === 'uat' || round.sourceStage === 'review' ? round : null;
}
