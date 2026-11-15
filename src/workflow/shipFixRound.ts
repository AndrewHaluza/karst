import type { Store } from '../store/db.js';
import { setStage } from '../store/stages.js';
import { setStageCurrent } from '../store/tickets.js';
import { activeRecoverySeries, openRecoveryRound } from '../store/recoveryRounds.js';
import { capForGate, roundFixDecision } from './fixAttempts.js';
import { sendBackState, type SendBackUnavailableReason } from './sendBack.js';
import { nextRoundNumber } from './prFeedbackFix.js';
import { nowIso } from '../model/time.js';

/**
 * The CI round of a graph ticket (T1158, @arch:AP-08): a direct fix-stage session, not a send-back to Implement.
 *
 * The impl stage of a graph ticket runs a graph. A send-back to Implement opens impl again, and the session launch
 * there starts a NEW graph run (a full planner run); a plain impl session cannot pass the graph marker guard.
 * The fix stage is not graph-driven. So a CI failure (or a failed base-moved gate run) at `ship` opens a
 * ship-sourced recovery round and enters `fix`, exactly as `enterPrFeedbackFix` does for review feedback. The
 * driver's fix cascade then resumes the round in a plain session in the ticket worktree; the closed graph run stays
 * closed. The round's committed `max_rounds` (`capForGate('ship')`) bounds it, the same bound PR feedback uses.
 */

export type ShipFixRoundUnavailableReason = SendBackUnavailableReason | 'round-active' | 'exhausted';

export type ShipFixRoundState =
  | { readonly available: true; readonly round: number }
  | { readonly available: false; readonly reason: ShipFixRoundUnavailableReason };

export interface EnterShipFixRoundOpts {
  /** The failure text the fix brief quotes (the ship row's verdict). */
  readonly reason: string;
  /** The host log the brief tells the agent to read first, or null. */
  readonly artifactPath: string | null;
  readonly now?: () => string;
  /** Decision-point logging, prefixed `[ship]`. */
  readonly debug?: (message: string) => void;
}

export interface EnterShipFixRoundResult {
  readonly roundId: number;
  readonly round: number;
}

const TRIGGER_DETAIL_MAX = 300;

/** The first line of the reason, bounded: a causal summary, never the whole log. */
function triggerDetailOf(reason: string): string {
  const head = reason.split('\n')[0] ?? '';
  return head.length > TRIGGER_DETAIL_MAX ? `${head.slice(0, TRIGGER_DETAIL_MAX - 3)}...` : head;
}

/** Whether a CI round may enter fix now. The in-flight and landed rules are `sendBackState`'s, not a copy. */
export function shipFixRoundState(store: Store, ticketId: number): ShipFixRoundState {
  const sendBack = sendBackState(store, ticketId);
  if (!sendBack.available) return { available: false, reason: sendBack.reason };
  if (sendBack.stage !== 'ship') return { available: false, reason: 'stage' };
  if (activeRecoverySeries(store, ticketId, 'ship') !== null) return { available: false, reason: 'round-active' };
  const round = nextRoundNumber(store, ticketId);
  // The driver's own decision: a round opened at the cap is exhausted on the next drive and reaches no agent.
  if (roundFixDecision({ roundId: 0, round, maxRounds: capForGate('ship') }).kind === 'exhausted') {
    return { available: false, reason: 'exhausted' };
  }
  return { available: true, round };
}

/** Mark `ship` failed with the reason, open a ship-sourced CI round and enter `fix`, in ONE transaction. */
export function enterShipFixRound(store: Store, ticketId: number, opts: EnterShipFixRoundOpts): EnterShipFixRoundResult {
  const at = (opts.now ?? nowIso)();
  let out: EnterShipFixRoundResult | undefined;
  const apply = store.db.transaction(() => {
    const state = shipFixRoundState(store, ticketId);
    if (!state.available) {
      opts.debug?.(`[ship] ship fix round ticket ${ticketId}: refused — ${state.reason} (no mutation)`);
      throw new Error(`ship fix round refused: ticket ${ticketId} (${state.reason})`);
    }
    setStage(store, ticketId, 'ship', { status: 'failed', verdict: opts.reason, attempt: state.round, artifactPath: opts.artifactPath, endedAt: at });
    const round = openRecoveryRound(store, {
      ticketId,
      sourceStage: 'ship',
      sourceProcessId: 'ci',
      sourceStageRunId: null,
      sourceProcessRunId: null,
      triggerKind: 'ci-failure',
      triggerDetail: triggerDetailOf(opts.reason),
      maxRounds: capForGate('ship'),
      startedAt: at,
    });
    setStage(store, ticketId, 'fix', {
      status: 'running', verdict: null, attempt: 0, artifactPath: null, startedAt: at, endedAt: null,
      blockedKind: null, blockedReason: null, blockedAt: null,
    });
    setStageCurrent(store, ticketId, 'fix');
    // A person or autopilot decided, as with a send-back: an old stop or pause of ship no longer holds (T1122).
    store.db.prepare('UPDATE autopilot_tickets SET stopped_reason = NULL, stopped_head_sha = NULL, paused_reason = NULL WHERE ticket_id = ?').run(ticketId);
    out = { roundId: round.id, round: round.round };
    opts.debug?.(`[ship] ship fix round ticket ${ticketId}: round ${round.round} (id ${round.id}) opened; ticket moved to fix`);
  });
  apply();
  if (out === undefined) throw new Error('ship fix round did not land');
  return out;
}
