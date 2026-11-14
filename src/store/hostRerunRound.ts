import type { Store } from './db.js';

/**
 * The one host re-run of a source stage's failed gates a refused no-new-commit
 * fix marker may trigger, once per fix round (v94 `recovery_rounds.host_rerun_at`).
 *
 * Stamps the round BEFORE the gates run, so a second refused marker — or a host
 * restart mid-run — can never start another run. Returns false when the round
 * was already stamped (or is gone); the caller then does not re-run.
 */
export function claimHostRerun(store: Store, roundId: number, at: string): boolean {
  const result = store.db
    .prepare('UPDATE recovery_rounds SET host_rerun_at = ? WHERE id = ? AND host_rerun_at IS NULL')
    .run(at, roundId);
  return Number(result.changes) === 1;
}

/**
 * Close a round `passed` with the reason the status alone does not say. The
 * round stays as history (append-only); only its own row is stamped.
 */
export function closeRoundPassed(store: Store, roundId: number, reason: string, at: string): void {
  store.db
    .prepare("UPDATE recovery_rounds SET status = 'passed', end_reason = ?, ended_at = ? WHERE id = ?")
    .run(reason, at, roundId);
}

/**
 * Move a still-`fixing` round out of the in-flight set when the host decides the
 * failure is not fixable from the session: `interrupted` (the same resting state
 * as a fix that died without its marker). Stamps `end_reason` with the park
 * verdict; the row stays as history. A round in any other status is left alone.
 */
export function parkRoundOutOfFixing(store: Store, roundId: number, reason: string, at: string): boolean {
  const result = store.db
    .prepare(
      "UPDATE recovery_rounds SET status = 'interrupted', end_reason = ?, ended_at = ? WHERE id = ? AND status = 'fixing'",
    )
    .run(reason, at, roundId);
  return Number(result.changes) === 1;
}

/**
 * A refused host CLI fix marker asks the extension for the host re-run (v112
 * `recovery_rounds.host_rerun_requested_at`). One request per round, and none once the
 * re-run ran (`host_rerun_at`). Returns false when the request is not new.
 */
export function claimHostRerunRequest(store: Store, roundId: number, at: string): boolean {
  const result = store.db
    .prepare('UPDATE recovery_rounds SET host_rerun_requested_at = ? WHERE id = ? AND host_rerun_requested_at IS NULL AND host_rerun_at IS NULL')
    .run(at, roundId);
  return Number(result.changes) === 1;
}

/** Tickets of one project whose active round asked for the host re-run that has not started. */
export function ticketsWithRequestedHostRerun(store: Store, projectId: number): number[] {
  const rows = store.db
    .prepare(
      `SELECT DISTINCT r.ticket_id FROM recovery_rounds r JOIN tickets t ON t.id = r.ticket_id
        WHERE t.project_id = ? AND r.status IN ('pending','fixing') AND r.host_rerun_requested_at IS NOT NULL AND r.host_rerun_at IS NULL`,
    )
    .all(projectId) as { ticket_id: number }[];
  return rows.map((r) => r.ticket_id);
}

/**
 * Whether an earlier round of this ticket and source stage already closed because the host's
 * re-run found the gates green. The pre-brief re-run uses it to bound a repeating environment
 * failure: after one such close, the next failure goes to the agent.
 */
export function hostRerunPassedBefore(store: Store, ticketId: number, sourceStage: string, reason: string, exceptRoundId: number): boolean {
  const row = store.db
    .prepare("SELECT 1 FROM recovery_rounds WHERE ticket_id = ? AND source_stage = ? AND status = 'passed' AND end_reason = ? AND id <> ? LIMIT 1")
    .get(ticketId, sourceStage, reason, exceptRoundId);
  return row !== undefined;
}

/**
 * The longest a host re-run reads in flight: the gate slot wait plus the longest UI gate run. A claim
 * older than this belongs to a host that died mid-run, so the ticket returns to its normal reading.
 */
export const HOST_RERUN_READING_MAX_MS = 2 * 60 * 60 * 1000;

/**
 * Record that a claimed host re-run ended without closing or parking the round (the pre-brief re-run
 * that failed: the agent then works the brief). `end_reason` ends the in-flight reading; the round
 * stays `fixing`. Returns false when the round is not an open round or already has a reason.
 */
export function markHostRerunFailed(store: Store, roundId: number, reason: string): boolean {
  const result = store.db
    .prepare("UPDATE recovery_rounds SET end_reason = ? WHERE id = ? AND status IN ('pending','fixing') AND end_reason IS NULL")
    .run(reason, roundId);
  return Number(result.changes) === 1;
}

/**
 * Whether the host re-run of a ticket's ACTIVE fix round is in flight (derived at load, never
 * stored): the round is still `fixing`, the host claimed its one re-run less than
 * `HOST_RERUN_READING_MAX_MS` ago, and no result was recorded. Closing the round passed, parking it,
 * or `markHostRerunFailed` ends the reading.
 */
export function readHostRerunning(store: Store, ticketId: number, nowMs: number = Date.now()): boolean {
  const cutoff = new Date(nowMs - HOST_RERUN_READING_MAX_MS).toISOString();
  const row = store.db
    .prepare(
      "SELECT 1 AS hit FROM recovery_rounds WHERE ticket_id = ? AND status = 'fixing' AND host_rerun_at IS NOT NULL AND host_rerun_at > ? AND end_reason IS NULL LIMIT 1",
    )
    .get(ticketId, cutoff);
  return row !== undefined;
}

/** The reason a restart gives to a claimed host re-run it finds with no run behind it. */
export const HOST_RERUN_ORPHANED_REASON = 'the host restarted during the re-run';

/**
 * At host start nothing of this process runs yet, so every open round that holds a claim with no
 * result is orphaned: its re-run died with the previous host. End the in-flight reading of each; the
 * round stays open (the one re-run per round stays used). Returns the number of rounds ended.
 */
export function endOrphanedHostReruns(store: Store): number {
  const result = store.db
    .prepare(
      "UPDATE recovery_rounds SET end_reason = ? WHERE status IN ('pending','fixing') AND host_rerun_at IS NOT NULL AND end_reason IS NULL",
    )
    .run(HOST_RERUN_ORPHANED_REASON);
  return Number(result.changes);
}
