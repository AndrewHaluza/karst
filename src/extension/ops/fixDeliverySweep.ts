import { formatFixBriefNumber } from '../../model/entityId.js';
import {
  claimArmed,
  clearEnqueued,
  listOpenFixDeliveries,
  rearmFixDelivery,
  type FixDelivery,
} from '../../store/fixDeliveries.js';
import { DELIVERY_CHECK_MS } from './fixWatchdog.js';
import { claimPointerFailed } from '../../store/fixDeliveries.js';
import { activeFixRound } from '../../store/recoveryRoundsRead.js';
import { getTicket } from '../../store/tickets.js';
import {
  failPointer,
  hasPendingFixIntent,
  isPushRoute,
  sendTypedPointer,
  type FixDeliveryHost,
} from './fixDeliveryOps.js';

/**
 * The fix-delivery sweep (@arch:V77): owns every TYPED send, the re-arm on a
 * session-generation change, and the escalation ladder. Push-route first pointers
 * normally come from the turn-end hook; this sweep only steps in when the hook
 * never fires (an idle agent) or the pointer went unread.
 *
 * Every typed send is HELD while the agent is mid-turn (`agent_state==='running'`),
 * so nothing is typed into a running turn on any core. All state lives in the
 * row's columns behind conditional claims — safe across windows and reloads.
 */

/** A push-route delivery nobody pointed at (idle agent): type it after this. */
export const ARMED_FIX_TIMEOUT_MS = 60_000;
/** An unread pointer is re-sent once, typed, after this. */
export const FIX_POINTER_RESEND_MS = 5 * 60_000;
/** An unread re-send turns the ticket into a needs-you after this. */
export const FIX_UNREAD_NEEDS_YOU_MS = 15 * 60_000;
/** A typed line claimed in flight but never typed (lost with a reload) is freed after this. */
export const FIX_ENQUEUE_STALE_MS = 2 * 60_000;
/** A sandboxed pointer still unsendable after this raises Needs you once (the delivery-guard window). */
export const FIX_POINTER_UNSENDABLE_MS = DELIVERY_CHECK_MS;
/** Minimum gap between two resend attempts for one row, in this window. */
const RESEND_RETRY_MS = 60_000;

export interface FixDeliverySweepDeps extends FixDeliveryHost {
  /** The window's bound project; undefined sweeps nothing. */
  projectId: () => number | undefined;
}

export interface FixDeliverySweep {
  sweep(): void;
}

export function makeFixDeliverySweep(deps: FixDeliverySweepDeps): FixDeliverySweep {
  const lastResendAt = new Map<number, number>();

  const ageMs = (stamp: string): number => Date.parse(deps.now()) - Date.parse(stamp);

  /** The gates every row passes before any rule applies. */
  function gated(row: FixDelivery): boolean {
    const { store } = deps;
    // A sandboxed row escalated to Needs you stays deliverable: a briefly stuck
    // pointer must still reach the agent once it is live/idle again.
    if (row.pointerFailedAt !== null && !(deps.retryAfterFailure?.(row.ticketId) === true && row.pointedAt === null && row.readAt === null)) return false;
    if (deps.isGraphTicket(row.ticketId)) return false;
    if (getTicket(store, row.ticketId).stageCurrent !== 'fix') return false;
    // A tracked row is live only while its round is: a settled/parked round is
    // the stall watchdog's, and wins over this sweep.
    if (row.recoveryRoundId !== null && activeFixRound(store, row.ticketId)?.id !== row.recoveryRoundId) {
      return false;
    }
    if (!deps.isLive(row.ticketId)) return false;
    return !hasPendingFixIntent(store, row.launchId);
  }

  /**
   * A sandboxed brief whose typed pointer cannot be sent (no session / conversation,
   * so `isLive` or the pending-intent gate below would skip the row for ever): after
   * the delivery-guard window claim `pointer_failed_at` once and raise Needs you,
   * naming the inbox file. Runs BEFORE `gated` for exactly that reason.
   */
  function escalateUnsendable(row: FixDelivery): void {
    const { store } = deps;
    if (deps.unsendableInbox === undefined) return;
    if (row.pointerFailedAt !== null || row.pointedAt !== null || row.readAt !== null) return;
    if (deps.isGraphTicket(row.ticketId)) return;
    if (getTicket(store, row.ticketId).stageCurrent !== 'fix') return;
    if (row.recoveryRoundId !== null && activeFixRound(store, row.ticketId)?.id !== row.recoveryRoundId) return;
    if (ageMs(row.createdAt) < FIX_POINTER_UNSENDABLE_MS) return;
    const file = deps.unsendableInbox(row.ticketId, row.id);
    if (file === null) return;
    if (!claimPointerFailed(store, row.id, deps.now())) return;
    deps.debug(`[driver] fix delivery ${formatFixBriefNumber(row.id)}: pointer unsendable — brief is in ${file}`);
    deps.needsYou(row.ticketId, `the fix pointer could not be sent; the brief is in ${file} — paste a pointer to it`);
  }

  function apply(row: FixDelivery): void {
    const { store } = deps;
    const route = deps.routeFor(row.ticketId);
    const push = isPushRoute(route);
    const current = deps.currentLaunchId(row.ticketId);
    // Rule 1 — re-arm: the generation changed with no fix relaunch (resume /
    // switch / adopt of the SAME delivery). Fresh clock; no send this tick.
    if (current !== undefined && current !== row.launchId) {
      const moved = rearmFixDelivery(store, row.id, {
        from: row.launchId,
        to: current,
        armed: push,
        at: deps.now(),
      });
      if (moved) deps.debug(`[driver] fix delivery ${formatFixBriefNumber(row.id)}: re-armed for launch ${current}`);
      return;
    }
    const running = deps.isRunning(row.ticketId);
    // A claimed-in-flight line that was never typed (lost with a reload).
    if (row.enqueuedAt !== null && row.pointedAt === null && ageMs(row.enqueuedAt) >= FIX_ENQUEUE_STALE_MS) {
      clearEnqueued(store, row.id);
      return;
    }
    // Rule 0 — the typed route's first send (also after a re-arm or a drop).
    if (!push && row.enqueuedAt === null && row.pointedAt === null) {
      if (!running) sendFirst(row);
      return;
    }
    // A push route that was never armed (the row was written while the core was
    // unknown and typed): arm it now so the hook, then rule 3, can deliver it.
    if (push && row.armedAt === null && row.enqueuedAt === null && row.pointedAt === null) {
      claimArmed(store, row.id, deps.now());
      return;
    }
    // Rule 3 — a push-route delivery the hook never pointed at (idle agent).
    if (
      push &&
      row.armedAt !== null &&
      row.enqueuedAt === null &&
      row.pointedAt === null &&
      ageMs(row.armedAt) >= ARMED_FIX_TIMEOUT_MS
    ) {
      if (!running) sendFirst(row);
      return;
    }
    // Rule 5 — escalate before re-sending again.
    if (row.repointedAt !== null && ageMs(row.repointedAt) >= FIX_UNREAD_NEEDS_YOU_MS) {
      deps.needsYou(row.ticketId, 'the fix brief was pointed at twice and never read');
      return;
    }
    // Rule 4 — one typed re-send of an unread pointer, on every route.
    if (
      row.pointedAt !== null &&
      row.repointedAt === null &&
      ageMs(row.pointedAt) >= FIX_POINTER_RESEND_MS &&
      !running &&
      Date.parse(deps.now()) - (lastResendAt.get(row.id) ?? 0) >= RESEND_RETRY_MS
    ) {
      lastResendAt.set(row.id, Date.parse(deps.now()));
      const sent = sendTypedPointer(deps, row, 'resend');
      if (sent === 'pointer-null') failPointer(deps, row);
    }
  }

  function sendFirst(row: FixDelivery): void {
    // Rule 2 — an unbuildable pointer fails the delivery once.
    if (sendTypedPointer(deps, row, 'first') === 'pointer-null') failPointer(deps, row);
  }

  return {
    sweep(): void {
      const projectId = deps.projectId();
      if (projectId === undefined) return;
      for (const row of listOpenFixDeliveries(deps.store, projectId)) {
        try {
          escalateUnsendable(row);
          if (gated(row)) apply(row);
        } catch (err) {
          // One bad row must never starve the rest; the next tick retries.
          deps.debug(`[driver] fix delivery ${formatFixBriefNumber(row.id)}: sweep failed (${err instanceof Error ? err.message : String(err)})`);
        }
      }
    },
  };
}
