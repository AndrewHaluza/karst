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
