import type { Store } from './db.js';
import { ROUND_SELECT, rowToRound, type RecoveryRound, type RecoveryRoundRow } from './recoveryRoundsRead.js';

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
