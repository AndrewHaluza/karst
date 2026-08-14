import type { Store } from '../store/db.js';
import type { StageKey } from '../model/types.js';
import { getTicket } from '../store/tickets.js';
import { getStage, setStage } from '../store/stages.js';
import { latestStageRun } from '../store/stageRuns.js';
import { listCurrentPrsByTicket } from '../store/prs.js';
import { nowIso } from '../model/time.js';

/**
 * The unified "Send back to Implement" recovery action (869ehkkzp).
 *
 * One exceptional escape hatch for "the implementation is not what I expected"
 * during validation or before landing. It is deliberately NOT modelled as a
 * verdict edge on the graph and NOT reachable from the agent CLI: the stage
 * machine's transitions stay verdict-keyed and the agent's marker stages stay
 * exactly the ones `cli/stage.ts` allows. This is a host-only recovery path —
 * a dedicated mutation, guarded the way every other irreversible dashboard
 * action is, offered from the current stage header's ⋯ menu at uat/review/ship
 * while the ticket has not landed.
 *
 * Everything downstream of the move (uat/review/ship) is INVALIDATED as current
 * state: their stage rows reset to "has not run yet", so a green uat/review
 * beside a ticket that must run them again is impossible and re-entering the
 * stages re-runs them normally (a stage row is current state, not evidence —
 * the append-only history in `gate_runs`/`review_findings`/`uat_findings`/
 * `ship_runs`/`stage_runs` and the PR rows is untouched).
 */

/** The stages whose header may offer the recovery action. `done` never can. */
export const SEND_BACK_STAGES: readonly StageKey[] = ['uat', 'review', 'ship'] as const;

/** Why the recovery action is not being offered right now. */
export type SendBackUnavailableReason = 'stage' | 'in-flight' | 'landed';

/** The host's verdict on offering the action, mirroring `mergeGateState`'s shape. */
export type SendBackState =
  | { available: true; stage: StageKey }
  | { available: false; reason: SendBackUnavailableReason };

/** True only for the stages the recovery action is ever offered at. */
export function isSendBackStage(stage: string | null | undefined): stage is StageKey {
  return stage === 'uat' || stage === 'review' || stage === 'ship';
}

/**
 * Whether the recovery action may be offered for the ticket RIGHT NOW.
 *
 * Refuses when:
 *  - the ticket is not at uat/review/ship (`stage`) — Scope/Implement/Fix/Done
 *    never offer it;
 *  - the current stage has an active run in flight (`in-flight`) — mutating the
 *    ticket underneath a running UAT/Review/Ship operation would race the
 *    driver's verdict. "In flight" is a run that is OPEN: a `stage_runs` row
 *    still marked running (v25). The raw `status: 'running'` column is NOT the
 *    signal — the machine enters every gate stage `running` (entryPatch) and
 *    leaves it that way across a stopped run, a stage entered but not yet
 *    driven, and a legacy row, none of which have anything in flight. A stage
 *    with no active run is settled and safe to move whether it is parked
 *    (blocked), stopped, or merely entered — `stage_runs` exists to resolve
 *    exactly that ambiguity. Ship records no stage_runs row of its own (its
 *    saga lives in ship_runs), so its in-flight signal is the stage cell's own
 *    `running`, set by stages/ship while the saga runs;
 *  - the ticket is at ship and any current PR has actually merged (`landed`) —
 *    partial landing is external reality and cannot be rolled back, so the
 *    action stops being offered the moment landing begins.
 *
 * Pure over the store, exactly like `mergeGateState`, so the whole decision is
 * testable against an in-memory DB.
 */
export function sendBackState(store: Store, ticketId: number): SendBackState {
  const ticket = getTicket(store, ticketId);
  if (!isSendBackStage(ticket.stageCurrent)) return { available: false, reason: 'stage' };
  const stage = ticket.stageCurrent;
  const cell = getStage(store, ticketId, stage);
  const activeRun = latestStageRun(store, ticketId, stage);
  const runInFlight = activeRun?.status === 'running';
  const shipSaga = stage === 'ship' && cell?.status === 'running';
  if (runInFlight || shipSaga) {
    return { available: false, reason: 'in-flight' };
  }
  if (stage === 'ship' && listCurrentPrsByTicket(store, ticketId).some((p) => p.status === 'merged')) {
    return { available: false, reason: 'landed' };
  }
  return { available: true, stage };
}

/** What the recovery mutation returns: the stage the ticket was moved back from. */
export interface SendBackResult {
  from: StageKey;
}

/**
 * Move the ticket back to Implement through the ONE explicit recovery path.
 *
 * This is the dedicated mutation — it never calls `transition`, never consumes
 * or bumps a stage attempt, and never authors a verdict. The availability
 * checks are re-run INSIDE the transaction, against the same store it mutates,
 * so a ticket a sweep or a teammate's merge moved between the click and this
 * call is refused rather than mutated underneath its new state.
 *
 * The mutation is one atomic write over `stages` + `tickets.stage_current`:
 *  - `impl` is entered the way the machine enters a running stage, with its
 *    previous end stamp explicitly cleared so a stale pass cannot read as still
 *    valid;
 *  - uat/review/ship rows reset to "has not run yet" — the invalidation that
 *    stops old pass state being presented as current proof. Their append-only
 *    evidence is untouched, and nothing here touches worktrees, commits,
 *    findings, gate evidence, `prs`, or `ship_runs`: at ship the existing open
 *    PRs stay exactly as they are, and ship's own logic decides what to reuse
 *    when the ticket reaches it again.
 *
 * `done` means merged stays an invariant of the graph — this never creates a
 * `done` row and never reaches the landing gate.
 */
export function sendBackToImplement(
  store: Store,
  ticketId: number,
  opts?: {
    now?: () => string;
    /** Verbose decision-point logging (§ debug logging), prefixed `[send-back]`. */
    debug?: (message: string) => void;
  },
): SendBackResult {
  const at = (opts?.now ?? nowIso)();
  let from: StageKey = 'uat';
  const apply = store.db.transaction(() => {
    const state = sendBackState(store, ticketId);
    if (!state.available) {
      opts?.debug?.(
        `[send-back] ticket ${ticketId}: refused — ${state.reason} (no mutation)`,
      );
      throw new Error(`send back refused: ticket ${ticketId} is not recoverable (${state.reason})`);
    }
    from = state.stage;
    opts?.debug?.(
      `[send-back] ticket ${ticketId}: moving back to impl from '${from}' ` +
        `(downstream uat/review/ship reset to pending; evidence and PRs kept)`,
    );
    setStage(store, ticketId, 'impl', {
      status: 'running',
      verdict: null,
      attempt: 0,
      artifactPath: null,
      startedAt: at,
      endedAt: null,
      blockedKind: null,
      blockedReason: null,
      blockedAt: null,
    });
    for (const key of SEND_BACK_STAGES) {
      setStage(store, ticketId, key, {
        status: 'pending',
        verdict: null,
        attempt: 0,
        artifactPath: null,
        startedAt: null,
        endedAt: null,
        blockedKind: null,
        blockedReason: null,
        blockedAt: null,
      });
    }
    store.db
      .prepare('UPDATE tickets SET stage_current = ? WHERE id = ?')
      .run('impl', ticketId);
  });
  apply();
  return { from };
}
