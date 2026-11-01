import { fixPointer, mailPointer, markerNudgeText, messagePointer, type DeliveryChannel } from '../workflow/messageDelivery.js';
import type { HookReply, HookReplyFor } from './endpoint.js';
import { formatId } from '../model/entityId.js';

/**
 * The host half of the mail reply channel: turns a hook's turn-end event into
 * the fixed pointer the recipient's bridge/plugin pushes. Kept vscode-free so
 * the guards are unit-testable in isolation from the extension host.
 *
 * Rules, in order:
 *  - only a turn-end event (`Stop` / opencode `session.idle`) is eligible;
 *  - a `Stop` carrying `stop_hook_active` is the agent CONTINUING from a prior
 *    block, not a fresh turn end: no reply, and the batch's one-block budget is
 *    left untouched (a core that sends the flag cannot spend the block on a
 *    reply its bridge discards);
 *  - the reply is bound to the CURRENT launch generation — a stale bridge from
 *    a retired core gets nothing and can never claim delivery;
 *  - the unread count comes from the in-memory cache (the reply builder itself
 *    performs no DB query; the endpoint tops the count up for the admitted
 *    ticket before calling this);
 *  - the pointer is built with the RECIPIENT session's CLI env, never the
 *    sender's (the sender is not even known here);
 *  - blocked at most once per BATCH, so a core without a `stop_hook_active`
 *    loop guard cannot be blocked twice for the same mail. The batch is keyed by
 *    the unread watermark (highest message id), not the count: reading a batch
 *    and receiving a same-sized new one must block again, and the count alone
 *    cannot tell those apart.
 */
export interface BlockedAt {
  launchId: string | undefined;
  watermark: number;
}

/** The fix delivery a Stop was already blocked for, per ticket (one pointer per delivery). */
export interface BlockedAtFix {
  launchId: string | undefined;
  deliveryId: number;
}

/** The fix delivery / round a Stop was already nudged for, per ticket (one nudge per key). */
export interface NudgedAt {
  launchId: string | undefined;
  stage: 'impl' | 'fix';
  key: number;
}

/**
 * A turn that ended after tool work with the done marker still pending, as
 * `dispatchHook` snapshotted it before resetting the turn tracker. `key` is the
 * implementation run id (impl) or recovery round id (fix); `processRunId` is the
 * run whose `prompt_telemetry` records `markerNudged`.
 */
export interface MarkerNudgeCandidate {
  stage: 'impl' | 'fix';
  key: number;
  processRunId: number | null;
}

export interface MailReplyDeps {
  /** The in-memory unread count for a ticket. */
  unread: (ticketId: number) => number;
  /** The unread batch identity (highest message id) for a ticket. */
  unreadWatermark: (ticketId: number) => number;
  /** The generation barrier: is `launchId` the ticket's current live session? */
  isCurrent: (ticketId: number, launchId: string | undefined) => boolean;
  /**
   * Whether the recipient is ELIGIBLE for a reply right now — its route is a
   * hook/plugin push, it is mid-turn, and the graph coordinator does not own
   * its session. The sweep computes this in memory (route + graph-owned +
   * busy) and the endpoint reads it, so the reply path never queries the DB.
   * Defaults to true.
   */
  shouldReply?: (ticketId: number) => boolean;
  /** How the RECIPIENT session reaches karst (`cli-env` when unknown). */
  sessionChannel: (ticketId: number) => DeliveryChannel;
  /**
   * Per-TICKET record of the launch and unread watermark already blocked for.
   * Keyed by ticket, not launch, so a core switch overwrites the entry instead
   * of leaving a retired launch's row behind; the entry is dropped when the
   * mail is read or the generation goes stale.
   */
  blockedAt: Map<number, BlockedAt>;
  /**
   * The fix-brief channel (@arch:V77), rides the same Stop reply. `fixEligible`
   * returns the delivery id the hook may point at (armed, unpointed, unread,
   * current generation — decided by the store, never by `agent_state`);
   * `claimFixPointed` is the conditional `pointed_at` claim, so only ONE window's
   * hook answers. Fix goes before mail: one block per Stop chain, and mail waits
   * for the next fresh turn end. `blockedAtFix` is separate from `blockedAt`.
   */
  fixEligible?: (ticketId: number) => number | null;
  /** The ticket's current stage, so the fix pointer names a marker only where one exists. */
  ticketStage?: (ticketId: number) => string | null;
  claimFixPointed?: (ticketId: number, deliveryId: number) => boolean;
  blockedAtFix?: Map<number, BlockedAtFix>;
  /**
   * The marker nudge (last priority): the in-memory snapshot `dispatchHook` took
   * at this turn end, or null. `nudgedAt` holds the key already nudged, so a
   * refused marker can never loop; `onNudged` records `markerNudged` telemetry.
   */
  nudgeEligible?: (ticketId: number) => MarkerNudgeCandidate | null;
  nudgedAt?: Map<number, NudgedAt>;
  onNudged?: (ticketId: number, candidate: MarkerNudgeCandidate) => void;
  debug?: (message: string) => void;
}

/** The once-per-key marker nudge, or null (no snapshot, already nudged for this key). */
function nudgeReply(deps: MailReplyDeps, ticketId: number, launchId: string | undefined): HookReply | null {
  if (deps.nudgeEligible === undefined || deps.nudgedAt === undefined) return null;
  const candidate = deps.nudgeEligible(ticketId);
  if (candidate === null) {
    deps.nudgedAt.delete(ticketId);
    return null;
  }
  const prev = deps.nudgedAt.get(ticketId);
  if (prev !== undefined && prev.launchId === launchId && prev.stage === candidate.stage && prev.key === candidate.key) {
    return null;
  }
  deps.nudgedAt.set(ticketId, { launchId, stage: candidate.stage, key: candidate.key });
  deps.onNudged?.(ticketId, candidate);
  deps.debug?.(`[driver] delivery reply ${formatId('ticket', ticketId)}: marker nudge (${candidate.stage})`);
  return { decision: 'block', reason: markerNudgeText(candidate.stage, deps.sessionChannel(ticketId)) };
}

/** A fix pointer for this turn end, or null (nothing eligible, already blocked, lost the claim). */
function fixReply(deps: MailReplyDeps, ticketId: number, launchId: string | undefined): HookReply | null {
  if (deps.fixEligible === undefined || deps.claimFixPointed === undefined || deps.blockedAtFix === undefined) {
    return null;
  }
  const deliveryId = deps.fixEligible(ticketId);
  if (deliveryId === null) {
    deps.blockedAtFix.delete(ticketId);
    return null;
  }
  const prev = deps.blockedAtFix.get(ticketId);
  if (prev !== undefined && prev.launchId === launchId && prev.deliveryId === deliveryId) return null;
  const line = messagePointer(fixPointer(deliveryId, deps.ticketStage?.(ticketId) ?? null), deps.sessionChannel(ticketId));
  if (!deps.claimFixPointed(ticketId, deliveryId)) return null;
  deps.blockedAtFix.set(ticketId, { launchId, deliveryId });
  deps.debug?.(`[driver] delivery reply ${formatId('ticket', ticketId)}: fix pointer #${deliveryId}`);
  return { decision: 'block', reason: line };
}

export function makeHookReply(deps: MailReplyDeps): HookReplyFor {
  return ({ ticketId, event, launchId, stopHookActive }) => {
    if (event !== 'Stop' && event !== 'session.idle') return null;
    // A continuation turn (Claude's stop_hook_active) is not a fresh turn end:
    // decline WITHOUT touching `blockedAt`, so the batch's one-block budget is
    // still available for the next plain Stop. The bridge also suppresses its
    // output here, so spending the budget would silently swallow the batch.
    if (stopHookActive === true) return null;
    if (!deps.isCurrent(ticketId, launchId)) {
      // A retired generation can never claim delivery; drop its record so the
      // map stays bounded by the tickets with unread mail.
      deps.blockedAt.delete(ticketId);
      deps.blockedAtFix?.delete(ticketId);
      deps.nudgedAt?.delete(ticketId);
      return null;
    }
    if (deps.shouldReply !== undefined && !deps.shouldReply(ticketId)) return null;
    const fix = fixReply(deps, ticketId, launchId);
    if (fix !== null) return fix;
    const unread = deps.unread(ticketId);
    if (unread < 1) {
      // The batch was read (or cleared): forget the block so the NEXT batch can
      // block again. This path is best-effort — a read with no intervening turn
      // end never reaches it — so the watermark below is the real guard.
      deps.blockedAt.delete(ticketId);
      return nudgeReply(deps, ticketId, launchId);
    }
    const watermark = deps.unreadWatermark(ticketId);
    const prev = deps.blockedAt.get(ticketId);
    if (prev !== undefined && prev.launchId === launchId && prev.watermark === watermark) {
      return nudgeReply(deps, ticketId, launchId);
    }
    const line = messagePointer(mailPointer(unread), deps.sessionChannel(ticketId));
    deps.blockedAt.set(ticketId, { launchId, watermark });
    deps.debug?.(`[driver] delivery reply ${formatId('ticket', ticketId)}: block (${unread} unread)`);
    const reply: HookReply = { decision: 'block', reason: line };
    return reply;
  };
}
