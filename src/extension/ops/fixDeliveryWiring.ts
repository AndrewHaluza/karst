import type { Store } from '../../store/db.js';
import type { ExportedCliEnv, CliTokens } from '../../agent/cliEnv.js';
import type { NudgeHooks } from '../../ui/nudgeQueue.js';
import { fixPointer, messagePointer } from '../../workflow/messageDelivery.js';
import { getTicket, setAgentState } from '../../store/tickets.js';
import {
  claimPointed,
  openFixDeliveryForLaunch,
  supersedeFixDeliveries,
  upsertFixDelivery,
} from '../../store/fixDeliveries.js';
import { renderDoneMarkerInstruction } from '../../agent/workflowCommand.js';
import { composeStageCommand } from '../../cli/stage.js';
import { composeFixBriefCommand } from '../../cli/fixBriefCommand.js';
import { formatTicketRef } from '../../model/entityId.js';
import { fixBriefForTicket } from './fixBriefForTicket.js';
import {
  deliverLiveFix,
  eligibleFixDelivery,
  type FixDeliveryHost,
  type TypedSendResult,
} from './fixDeliveryOps.js';
import { makeFixDeliverySweep, type FixDeliverySweep } from './fixDeliverySweep.js';
import { CODEX_STOP_BLOCK_SUPPORTED } from './mailDeliveryWiring.js';
import { messageRouteFor } from './messageDeliveryOps.js';

/** How often the fix-delivery sweep ticks; the 60 s armed fallback needs far finer than the 5-minute watchdog. */
export const FIX_DELIVERY_INTERVAL_MS = 15_000;

/**
 * The snapshot a fix round stores: the brief plus the done-marker instruction,
 * built from LITERAL host tokens (never session env refs), so the same body is
 * valid for any session generation and a re-arm never re-renders it. The seed
 * itself keeps today's env-ref composition; only the stored copy is literal.
 */
export function composeFixSnapshot(
  store: Store,
  ticketId: number,
  literal: CliTokens,
): { body: string; footer: string } {
  const t = getTicket(store, ticketId);
  const label = formatTicketRef(ticketId, t.key);
  const brief =
    fixBriefForTicket(store, ticketId, label) ??
    `A gate failed for ticket ${label}. Re-run the checks, fix what they report, and confirm they pass.`;
  const marker = renderDoneMarkerInstruction(
    composeStageCommand(literal.cli, literal.db, 'fix', literal.manifest),
    t.key || String(ticketId),
  );
  const live = composeFixBriefCommand(literal.cli, literal.db, literal.manifest);
  return {
    body: `${brief}\n\n${marker}`,
    footer: `… truncated; full live brief: ${live} --ticket ${t.key || String(ticketId)}`,
  };
}

export interface FixDeliveryWiringDeps {
  store: Store;
  projectId: () => number | undefined;
  isLive: (ticketId: number) => boolean;
  isGraphTicket: (ticketId: number) => boolean;
  /** The live session's core, from in-memory identity only. */
  sessionProvider: (ticketId: number) => string | null | undefined;
  /** `SessionRecovery.currentLaunchId`. */
  currentLaunchId: (ticketId: number) => string | undefined;
  /** Queue one typed line into the live terminal; false when none took it. */
  nudge: (ticketId: number, line: string, hooks: NudgeHooks) => boolean;
  sessionCliEnv: (ticketId: number) => ExportedCliEnv | undefined;
  literal: () => CliTokens;
  /** agy has not reported idle (its TUI swallows a line typed mid-turn). */
  agyBusy: (ticketId: number) => boolean;
  debug: (message: string) => void;
}

export interface FixDeliveryWiring {
  sweep: FixDeliverySweep;
  /** Live path: store the round's snapshot and point the live agent at it. */
  deliver: (ticketId: number, roundId: number | null) => boolean;
  /** Seed path: store the snapshot for a prepared fix launch (call inside the intent's transaction). */
  recordSeed: (ticketId: number, roundId: number, launchId: string) => void;
  /** Seed path, untracked round: the seed carries the newer brief, so older unread rows go stale. */
  supersedeUnread: (ticketId: number) => void;
  /** Delivery guard: type the pointer for the snapshot bound to an unconfirmed seed launch. */
  pointAtLaunch: (ticketId: number, launchId: string) => 'sent' | 'unsendable' | 'no-row';
  /** Hook channel: the delivery id the turn-end reply may point at, if any. */
  eligible: (ticketId: number) => number | null;
  claimPointed: (ticketId: number, deliveryId: number) => boolean;
}

export function makeFixDeliveryWiring(deps: FixDeliveryWiringDeps): FixDeliveryWiring {
  const now = (): string => new Date().toISOString();
  const host: FixDeliveryHost = {
    store: deps.store,
    now,
    debug: deps.debug,
    isGraphTicket: deps.isGraphTicket,
    isLive: deps.isLive,
    routeFor: (id) => messageRouteFor(deps.sessionProvider(id), CODEX_STOP_BLOCK_SUPPORTED),
    currentLaunchId: deps.currentLaunchId,
    isRunning: (id) => getTicket(deps.store, id).agentState === 'running',
    sendPointer: (id, deliveryId, hooks): TypedSendResult => {
      if (!deps.isLive(id) || deps.isGraphTicket(id)) return 'unavailable';
      if (deps.agyBusy(id)) return 'held';
      const line = messagePointer(fixPointer(deliveryId), id, deps.sessionCliEnv(id), deps.literal());
      if (line === null) return 'pointer-null';
      return deps.nudge(id, line, hooks) ? 'queued' : 'unavailable';
    },
    needsYou: (id, reason) => {
      // Only a quiet or idle agent is flagged: `running`/`waiting` are live
      // hook state that must never be overwritten with needs-you.
      const state = getTicket(deps.store, id).agentState ?? 'none';
      if (state !== 'none' && state !== 'idle') return;
      setAgentState(deps.store, id, 'not-started');
      deps.debug(`[driver] fix delivery: ticket ${id} needs you — ${reason}`);
    },
  };
  return {
    sweep: makeFixDeliverySweep({ ...host, projectId: deps.projectId }),
    deliver: (ticketId, roundId) => {
      const { body, footer } = composeFixSnapshot(deps.store, ticketId, deps.literal());
      return deliverLiveFix(host, { ticketId, roundId, body, truncatedFooter: footer });
    },
    recordSeed: (ticketId, roundId, launchId) => {
      const { body, footer } = composeFixSnapshot(deps.store, ticketId, deps.literal());
      upsertFixDelivery(deps.store, {
        ticketId,
        recoveryRoundId: roundId,
        launchId,
        body,
        truncatedFooter: footer,
        at: now(),
      });
    },
    supersedeUnread: (ticketId) => {
      supersedeFixDeliveries(deps.store, ticketId, now());
    },
    pointAtLaunch: (ticketId, launchId) => {
      const row = openFixDeliveryForLaunch(deps.store, launchId);
      if (row === null) return 'no-row';
      const result = host.sendPointer(ticketId, row.id, {
        onTyped: () => void claimPointed(deps.store, row.id, now()),
      });
      return result === 'queued' ? 'sent' : 'unsendable';
    },
    eligible: (ticketId) => eligibleFixDelivery(host, ticketId)?.id ?? null,
    claimPointed: (ticketId, deliveryId) => {
      void ticketId;
      return claimPointed(deps.store, deliveryId, now());
    },
  };
}
