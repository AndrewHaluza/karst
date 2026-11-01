import { formatFixBriefNumber } from '../../model/entityId.js';
import type { Store } from '../../store/db.js';
import type { NudgeHooks } from '../../ui/nudgeQueue.js';
import type { MessageRoute } from '../../workflow/messageDelivery.js';
import {
  claimArmed,
  claimEnqueued,
  claimPointed,
  claimPointerFailed,
  claimRepointed,
  clearEnqueued,
  claimRead,
  currentFixDelivery,
  getFixDelivery,
  supersedeFixDelivery,
  upsertFixDelivery,
  type FixDelivery,
} from '../../store/fixDeliveries.js';
import { getSessionLaunchIntent } from '../../store/sessionLaunchIntents.js';

/**
 * Fix-brief delivery, host-agnostic (@arch:V77, @arch:MAILBOX-WAKE). A fix round that
 * reaches a LIVE session stores its brief (`fix_deliveries`) and sends ONE fixed
 * pointer line through the same per-core route mail uses: the turn-end hook block
 * on push cores, a typed line on the rest. Nothing is ever typed into a running
 * turn on any core, and the agent's `fix-brief --ack` read is the receipt.
 *
 * Every transition is a conditional claim on the row, so two windows or a reload
 * never double-act. The sweep that retries and escalates lives in
 * `fixDeliverySweep.ts`.
 */

/** How a typed pointer attempt ended. */
export type TypedSendResult =
  /** Handed to the terminal's FIFO; `hooks` report the typed/dropped outcome. */
  | 'queued'
  /** A literal path carries a shell metacharacter: no pointer can be built. */
  | 'pointer-null'
  /** Deliberately not sent now (agy has not reported idle); retry later. */
  | 'held'
  /** No live terminal took it. */
  | 'unavailable';

export interface FixDeliveryHost {
  store: Store;
  /** ISO timestamp. */
  now: () => string;
  debug: (message: string) => void;
  isGraphTicket: (ticketId: number) => boolean;
  /** Live in THIS window (open or adoptable terminal). */
  isLive: (ticketId: number) => boolean;
  /** The ticket's CURRENT live core route, resolved at delivery time. */
  routeFor: (ticketId: number) => MessageRoute;
  /** `SessionRecovery.currentLaunchId`: the live session generation. */
  currentLaunchId: (ticketId: number) => string | undefined;
  /** agent_state === 'running' — mid-turn. Read by the sweep and the live path only. */
  isRunning: (ticketId: number) => boolean;
  /** Type the fix pointer for a delivery into the ticket's live terminal. */
  sendPointer: (ticketId: number, deliveryId: number, hooks: NudgeHooks) => TypedSendResult;
  /** Surface the ticket as needing a human; idempotent. */
  needsYou: (ticketId: number, reason: string) => void;
  /**
   * Sandboxed ticket: write the brief to `inbox/fix-<id>.md` now, whether or not
   * any session is known (@arch:AC-38). False = the write was refused (the sweep retries); true when written or not sandboxed.
   */
  writeBrief?: (ticketId: number, deliveryId: number) => boolean;
  /**
   * The inbox file (relative, e.g. `inbox/fix-7.md`) a human can point a sandboxed
   * agent at, when the typed pointer cannot be sent now (no live terminal / agy not
   * idle); null when the ticket is not sandboxed or the pointer is sendable.
   */
  unsendableInbox?: (ticketId: number, deliveryId: number) => string | null;
  /**
   * Sandboxed ticket: a `pointer_failed_at` claim (Needs you already raised) does
   * not end delivery; the sweep keeps trying the pointer once the agent recovers.
   */
  retryAfterFailure?: (ticketId: number) => boolean;
}

/** True when the route pushes through the core's turn-end reply channel. */
export function isPushRoute(route: MessageRoute): boolean {
  return route !== 'typed';
}

/** A fix launch for this generation is still waiting for its SessionStart. */
export function hasPendingFixIntent(store: Store, launchId: string | null): boolean {
  if (launchId === null) return false;
  const intent = getSessionLaunchIntent(store, launchId);
  return intent !== undefined && intent.purpose === 'fix' && intent.status === 'pending';
}

/**
 * The row the turn-end hook may point at right now, or null. Eligible = the
 * ticket's current row, armed but not yet pointed, unread, not superseded, not
 * failed, no typed line in flight, bound to the CURRENT session generation, and
 * not an unconfirmed seed launch (the delivery guard owns that one). The hook
 * reply never reads `agent_state`: at a turn end dispatch has already moved it
 * off `running`.
 */
export function eligibleFixDelivery(host: FixDeliveryHost, ticketId: number): FixDelivery | null {
  const row = currentFixDelivery(host.store, ticketId);
  if (row === null) return null;
  if (row.readAt !== null || row.pointerFailedAt !== null || row.enqueuedAt !== null) return null;
  if (row.armedAt === null || row.pointedAt !== null) return null;
  if (row.launchId !== (host.currentLaunchId(ticketId) ?? null)) return null;
  if (hasPendingFixIntent(host.store, row.launchId)) return null;
  return row;
}

/**
 * Send one typed pointer line. The FIRST send claims `enqueued_at` before it
 * enqueues (so the hook declines and no other tick doubles it) and claims
 * `pointed_at` only when the line is actually typed; a dropped line frees the
 * claim for a retry. A RE-send claims `repointed_at` on typing instead.
 */
export function sendTypedPointer(
  host: FixDeliveryHost,
  row: FixDelivery,
  kind: 'first' | 'resend',
): TypedSendResult | 'raced' {
  if (kind === 'first' && !claimEnqueued(host.store, row.id, host.now())) return 'raced';
  const result = host.sendPointer(row.ticketId, row.id, {
    onTyped: () => {
      if (kind === 'first') claimPointed(host.store, row.id, host.now());
      else claimRepointed(host.store, row.id, host.now());
    },
    onDropped: () => {
      if (kind === 'first') clearEnqueued(host.store, row.id);
    },
  });
  if (result !== 'queued' && kind === 'first') clearEnqueued(host.store, row.id);
  return result;
}

/** The pointer cannot be built: fail this delivery once and ask for a human. */
export function failPointer(host: FixDeliveryHost, row: FixDelivery): void {
  if (!claimPointerFailed(host.store, row.id, host.now())) return;
  host.debug(`[driver] fix delivery ${formatFixBriefNumber(row.id)}: pointer unbuildable — needs you`);
  host.needsYou(row.ticketId, 'the fix-brief pointer could not be built');
}

export interface DeliverLiveFixInput {
  ticketId: number;
  roundId: number | null;
  /** The snapshot body: brief + done marker with LITERAL CLI tokens. */
  body: string;
  /** Appended when the body exceeds the cap. */
  truncatedFooter: string;
}

/**
 * Deliver a fix round into a LIVE session: store the snapshot, then arm it (push
 * route, the hook points at the next turn end) or type the pointer (typed route,
 * only while the agent is not mid-turn; otherwise the sweep sends it on the
 * first idle tick). Returns false when nothing could deliver it; the row is then
 * superseded so no sweep ever points at an interrupted round.
 */
export function deliverLiveFix(host: FixDeliveryHost, input: DeliverLiveFixInput): boolean {
  const at = host.now();
  const id = upsertFixDelivery(host.store, {
    ticketId: input.ticketId,
    recoveryRoundId: input.roundId,
    launchId: host.currentLaunchId(input.ticketId) ?? null,
    body: input.body,
    truncatedFooter: input.truncatedFooter,
    at,
  });
  const row = currentFixDelivery(host.store, input.ticketId);
  if (row === null || row.id !== id) return false;
  // A refused write (tampered inbox) leaves the row for the sweep; nothing is typed this round.
  if (host.writeBrief?.(input.ticketId, id) === false) return true;
  const route = host.routeFor(input.ticketId);
  host.debug(`[driver] fix delivery ${formatFixBriefNumber(id)}: stored for ticket ${input.ticketId}, route ${route}`);
  if (isPushRoute(route)) {
    claimArmed(host.store, id, at);
    return true;
  }
  // Typed route: never type into a running turn — the sweep (rule 0) sends the
  // first pointer on the first non-running tick.
  if (host.isRunning(input.ticketId)) return true;
  const sent = sendTypedPointer(host, row, 'first');
  if (sent === 'pointer-null') {
    failPointer(host, row);
    return true;
  }
  if (sent === 'unavailable') {
    supersedeFixDelivery(host.store, id, host.now());
    return false;
  }
  // 'queued' is delivered; 'held' (agy not idle yet) is retried by the sweep.
  return true;
}

/**
 * The ack line from a sandboxed agent (arch:AC-34): `fix-<id>` marks that fix
 * delivery read, but only when it is a pending (unread, not superseded) delivery
 * of THIS ticket. A line never carries authority by itself: a foreign-ticket or
 * stale ref changes nothing. Returns whether a delivery was claimed.
 */
export function ackFixDeliveryRef(store: Store, ticketId: number, ref: string, at: string): boolean {
  const m = /^fix-([1-9][0-9]{0,9})$/.exec(ref);
  if (!m) return false;
  const row = getFixDelivery(store, Number(m[1]));
  if (row === null || row.ticketId !== ticketId || row.readAt !== null || row.supersededAt !== null) return false;
  return claimRead(store, row.id, 'pointer', at);
}
