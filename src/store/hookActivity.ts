import type { Store } from './db.js';
import { ROUND_SELECT, rowToRound, type RecoveryRoundRow } from './recoveryRoundsRead.js';
import {
  beginLiveFixExecution,
  reopenInterruptedRound,
  FIX_PARKED_STALLED,
} from './recoveryRoundsWrite.js';

/**
 * Record that a hook event was accepted for the ticket (T1111). The fix stall
 * watchdog counts it as progress. The stamp only moves forward.
 */
export function stampHookActivity(store: Store, ticketId: number, at: string): void {
  store.db
    .prepare(
      'UPDATE tickets SET last_hook_at = ? WHERE id = ? AND (last_hook_at IS NULL OR last_hook_at < ?)',
    )
    .run(at, ticketId, at);
}

/**
 * Lift a `FIX_PARKED_STALLED` park when the session works again (T1111).
 *
 * A hook event after the park proves the agent session is alive, so the park
 * was a false one. Guarded claim, all in one transaction:
 *  - the ticket is at `fix` and the fix row is `failed` with the stalled verdict
 *    (no other park verdict ever lifts);
 *  - the newest interrupted round has interrupt budget left (`interruptCount <
 *    maxRounds`) and `canResume` accepts it. The driver's own `roundFixDecision`
 *    is passed as `canResume`, so the two never disagree; the store may not
 *    import the workflow layer itself;
 *  - the park is older than the event.
 * The round then reopens through `reopenInterruptedRound` (the driver's own
 * path) and `beginLiveFixExecution` attaches a live run to it and sets the fix
 * stage back to `running` through `setStage`. No fix brief is sent: the session
 * already holds its brief (@arch:V77). Returns whether the park lifted.
 */
export function liftStalledFixPark(
  store: Store,
  ticketId: number,
  at: string,
  canResume: (round: { id: number; round: number; maxRounds: number }) => boolean,
): boolean {
  const lift = store.db.transaction((): boolean => {
    const stage = store.db
      .prepare(
        `SELECT s.status, s.verdict, s.ended_at
           FROM stages s JOIN tickets t ON t.id = s.ticket_id
          WHERE s.ticket_id = ? AND s.stage_key = 'fix' AND t.stage_current = 'fix'`,
      )
      .get(ticketId) as { status: string; verdict: string | null; ended_at: string | null } | undefined;
    if (stage === undefined || stage.status !== 'failed' || stage.verdict !== FIX_PARKED_STALLED) {
      return false;
    }
    if (stage.ended_at !== null && stage.ended_at > at) return false;
    const row = store.db
      .prepare(`${ROUND_SELECT} WHERE ticket_id = ? AND status = 'interrupted' ORDER BY id DESC LIMIT 1`)
      .get(ticketId) as RecoveryRoundRow | undefined;
    if (row === undefined) return false;
    const round = rowToRound(row);
    if (round.interruptCount >= round.maxRounds) return false;
    if (!canResume({ id: round.id, round: round.round, maxRounds: round.maxRounds })) return false;
    // The new run keeps the identity of the run the sweep marked stale: the same session works on.
    const prior = store.db
      .prepare('SELECT provider, model, agent_name FROM process_runs WHERE id = ?')
      .get(round.fixProcessRunId) as
      | { provider: string | null; model: string | null; agent_name: string | null }
      | undefined;
    if (!reopenInterruptedRound(store, ticketId, round.id)) return false;
    beginLiveFixExecution(store, {
      ticketId,
      roundId: round.id,
      provider: prior?.provider ?? null,
      model: prior?.model ?? null,
      agentName: prior?.agent_name ?? null,
      startedAt: at,
    });
    return true;
  });
  return lift();
}
