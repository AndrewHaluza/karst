import type { Store } from '../../store/db.js';
import { getTicket } from '../../store/tickets.js';
import type { ExportedCliEnv, CliTokens } from '../../agent/cliEnv.js';
import type { HookReplyFor } from '../../hooks/endpoint.js';
import { createUnreadCache } from '../../hooks/unreadCache.js';
import { makeHookReply, type BlockedAt } from '../../hooks/mailReply.js';
import {
  makeRoutedDelivery,
  makeTerminalDelivery,
  type MessageRoute,
} from '../../workflow/messageDelivery.js';
import {
  makeMessageDeliverySweep,
  messageRouteFor,
  type MessageDeliverySweep,
} from './messageDeliveryOps.js';

/**
 * Whether the live codex CLI honors a Stop-hook block reply. The shared bridge
 * implements the block for both claude and codex; this flag only chooses the
 * ROUTE, so flipping it can never emit a protocol the CLI does not read.
 *
 * SPIKE-CODEX-STOP-BLOCK (codex-cli 0.153.0 bundled binary): the Stop
 * command-hook output schema is claude-compatible — `{decision:"block",
 * reason:"…"}` is a valid `StopCommandOutputWire` (the binary carries
 * `BlockDecisionWire`, `HookEventNameWire`, and the error string "Stop hook
 * requested continuation without a prompt; ignoring the block"). `reason` is
 * the continuation prompt. Verified `true`.
 */
const CODEX_STOP_BLOCK_SUPPORTED = true;

/**
 * The extension-host wiring for mailbox delivery: the per-core routed sweep,
 * the in-memory unread cache the hook endpoint reads, and the hook reply
 * builder. Kept here (not in `extension.ts`) so the binding stays a thin
 * assembly and the route logic stays vscode-free and testable.
 */
export interface MailDeliveryWiringDeps {
  store: Store;
  projectId: () => number | undefined;
  isLive: (ticketId: number) => boolean;
  isGraphTicket: (ticketId: number) => boolean;
  integrating: (ticketId: number) => boolean;
  wake: (ticketId: number) => Promise<void> | void;
  now: () => number;
  debug: (message: string) => void;
  warn: (message: string) => void;
  /** The graph coordinator owns the session (`nudgeSurface === 'no-op'`). */
  graphOwned: (ticketId: number) => boolean;
  /** The recipient's agy session has not reported idle (typed route only). */
  agyBusy: (ticketId: number) => boolean;
  nudge: (ticketId: number, line: string) => boolean;
  /** The RECIPIENT session's exported CLI refs. */
  sessionCliEnv: (ticketId: number) => ExportedCliEnv | undefined;
  /**
   * The RECIPIENT's current live core, from IN-MEMORY session identity only.
   * Deliberately not the configured provider: this same closure backs the
   * endpoint's reply decision, which must not read the DB on the hook's hot
   * path. A session with no recorded identity falls to the typed route.
   */
  sessionProvider: (ticketId: number) => string | null | undefined;
  literal: () => CliTokens;
  /** The generation barrier for the reply channel. */
  isCurrentHook: (ticketId: number, launchId: string | undefined) => boolean;
}

export interface MailDeliveryWiring {
  sweep: MessageDeliverySweep;
  hookReply: HookReplyFor;
  /**
   * Refresh the in-memory unread cache for ONE ticket from the store. The hook
   * endpoint calls this when that ticket's turn ends, so a `message send` (a
   * separate CLI process) is reflected without waiting for the next sweep.
   */
  refreshUnread: (ticketId: number) => void;
  /**
   * Record that a hook-block reply was CONFIRMED delivered (the bridge got the
   * body). The sweep's typed fallback is suppressed only for confirmed batches.
   */
  onReplyDelivered: (ticketId: number) => void;
}

export function makeMailDeliveryWiring(deps: MailDeliveryWiringDeps): MailDeliveryWiring {
  const unreadCache = createUnreadCache();
  const blockedAt = new Map<number, BlockedAt>();
  // Batches CONFIRMED delivered by the reply channel (ticketId -> watermark).
  // `blockedAt` only says a reply was BUILT; this says the bridge received it.
  const confirmed = new Map<number, number>();
  // Which recipients the endpoint may answer with a push reply. The reply path
  // never reads the DB for this: it is a set lookup. Two writers keep it fresh:
  //  - the sweep rebuilds it from rows (push route + not graph-owned + mid-turn),
  //    so a ticket that drops off (read, idle, graph-owned, retired) leaves it;
  //  - the endpoint's per-turn top-up adds the ticket it is replying to (push
  //    route + not graph-owned, no `isBusy` — a hook reaching the endpoint IS
  //    the turn end, and dispatch has already moved it off `running`), so a send
  //    that lands between sweeps still gets its reply.
  // A top-up entry is transient: the next sweep's rebuild may drop it, but that
  // is harmless — the batch is already marked delivered, and the NEXT turn-end
  // top-up re-adds it before the reply is built.
  const replyEligible = new Set<number>();

  const typed = makeTerminalDelivery({
    isLive: deps.isLive,
    graphOwned: deps.graphOwned,
    agyBusy: deps.agyBusy,
    nudge: deps.nudge,
    sessionCliEnv: deps.sessionCliEnv,
    literal: deps.literal,
  });
  const routeFor = (ticketId: number): MessageRoute =>
    messageRouteFor(deps.sessionProvider(ticketId), CODEX_STOP_BLOCK_SUPPORTED);
  const isBusy = (ticketId: number): boolean =>
    getTicket(deps.store, ticketId).agentState === 'running';

  // A push route is reply-eligible when its core reads the reply and the graph
  // coordinator does not own the session. The sweep additionally requires
  // `isBusy` (the pointer only arrives at a turn end, so an idle recipient has
  // already passed it); the endpoint's per-turn top-up does NOT, because a hook
  // reaching it IS that turn end (dispatch has already moved the ticket off
  // `running`, so a live `isBusy` would wrongly refuse the very reply we want).
  const pushRoute = (ticketId: number): boolean =>
    routeFor(ticketId) !== 'typed' && !deps.graphOwned(ticketId);

  const sweep = makeMessageDeliverySweep({
    store: deps.store,
    projectId: deps.projectId,
    delivery: makeRoutedDelivery({
      routeFor,
      isLive: deps.isLive,
      graphOwned: deps.graphOwned,
      isBusy,
      typed,
    }),
    refreshUnread: (rows) => {
      unreadCache.replace(rows);
      replyEligible.clear();
      for (const row of rows) {
        if (pushRoute(row.toTicketId) && isBusy(row.toTicketId)) replyEligible.add(row.toTicketId);
      }
    },
    // The sweep skips a batch ONLY once the reply was CONFIRMED delivered (the
    // bridge wrote its block and received it) — never merely because a block was
    // built. The reply channel fails open, so a reply built but lost must keep
    // the sweep's typed fallback instead of stranding the batch. Keyed by
    // watermark, so a later batch still delivers.
    alreadyPushed: (ticketId, maxId) => (confirmed.get(ticketId) ?? 0) >= maxId,
    isLive: deps.isLive,
    isGraphTicket: deps.isGraphTicket,
    integrating: deps.integrating,
    wake: deps.wake,
    now: deps.now,
    debug: deps.debug,
    warn: deps.warn,
  });

  const hookReply = makeHookReply({
    unread: (ticketId) => unreadCache.get(ticketId),
    unreadWatermark: (ticketId) => unreadCache.watermark(ticketId),
    isCurrent: deps.isCurrentHook,
    shouldReply: (ticketId) => replyEligible.has(ticketId),
    sessionCliEnv: deps.sessionCliEnv,
    literal: deps.literal,
    blockedAt,
    debug: deps.debug,
  });

  // The endpoint calls this only after the block response reached the bridge.
  // The watermark comes from the reply's own blocked record (the batch it just
  // answered); the ticket's latest block is that batch.
  const onReplyDelivered = (ticketId: number): void => {
    const prev = blockedAt.get(ticketId);
    if (prev !== undefined) confirmed.set(ticketId, prev.watermark);
  };

  const refreshUnread = (ticketId: number): void => {
    unreadCache.refreshTicket(deps.store, ticketId);
    // The top-up also (re)sets eligibility, so a `message send` that lands
    // between sweeps still gets its reply on the very next turn end — the case
    // where the recipient had no prior unread and the sweep never saw it. The
    // reply's own unread guard is what withholds a block when nothing is
    // unread; eligibility only decides whether the ROUTE accepts a reply.
    if (pushRoute(ticketId)) replyEligible.add(ticketId);
    else replyEligible.delete(ticketId);
  };

  return { sweep, hookReply, refreshUnread, onReplyDelivered };
}
