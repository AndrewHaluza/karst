import type { ExportedCliEnv, CliTokens } from '../agent/cliEnv.js';
import { mailPointer, messagePointer } from '../workflow/messageDelivery.js';
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
  /** The RECIPIENT session's exported CLI refs, or `undefined` for literals. */
  sessionCliEnv: (ticketId: number) => ExportedCliEnv | undefined;
  /** Literal CLI tokens for a session that exported none. */
  literal: () => CliTokens;
  /**
   * Per-TICKET record of the launch and unread watermark already blocked for.
   * Keyed by ticket, not launch, so a core switch overwrites the entry instead
   * of leaving a retired launch's row behind; the entry is dropped when the
   * mail is read or the generation goes stale.
   */
  blockedAt: Map<number, BlockedAt>;
  debug?: (message: string) => void;
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
      return null;
    }
    if (deps.shouldReply !== undefined && !deps.shouldReply(ticketId)) return null;
    const unread = deps.unread(ticketId);
    if (unread < 1) {
      // The batch was read (or cleared): forget the block so the NEXT batch can
      // block again. This path is best-effort — a read with no intervening turn
      // end never reaches it — so the watermark below is the real guard.
      deps.blockedAt.delete(ticketId);
      return null;
    }
    const watermark = deps.unreadWatermark(ticketId);
    const prev = deps.blockedAt.get(ticketId);
    if (prev !== undefined && prev.launchId === launchId && prev.watermark === watermark) return null;
    const line = messagePointer(mailPointer(unread), ticketId, deps.sessionCliEnv(ticketId), deps.literal());
    if (line === null) return null;
    deps.blockedAt.set(ticketId, { launchId, watermark });
    deps.debug?.(`[driver] delivery reply ${formatId('ticket', ticketId)}: block (${unread} unread)`);
    const reply: HookReply = { decision: 'block', reason: line };
    return reply;
  };
}
