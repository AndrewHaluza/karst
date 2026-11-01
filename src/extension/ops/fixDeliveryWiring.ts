import type { Store } from '../../store/db.js';
import type { CliTokens } from '../../agent/cliEnv.js';
import type { NudgeHooks } from '../../ui/nudgeQueue.js';
import { fixPointer, inboxRef, isSandboxChannel, messagePointer, type DeliveryChannel, type SandboxChannel } from '../../workflow/messageDelivery.js';
import { getTicket, setAgentState } from '../../store/tickets.js';
import {
  claimPointed,
  currentFixDelivery,
  getFixDelivery,
  openFixDeliveryForLaunch,
  supersedeFixDeliveries,
  upsertFixDelivery,
} from '../../store/fixDeliveries.js';
import { renderDoneMarkerInstruction } from '../../agent/workflowCommand.js';
import { renderSandboxMarkerInstruction, scrubHostCli } from '../../agent/sandboxInstructions.js';
import type { BridgePaths } from '../../agent/bridge/bridgeDir.js';
import { writeInboxFile } from '../../agent/bridge/inbox.js';
import { composeStageCommand } from '../../cli/stage.js';
import { composeFixBriefCommand } from '../../cli/fixBriefCommand.js';
import { formatTicketRef } from '../../model/entityId.js';
import { listAttachments } from '../../store/attachments.js';
import { sandboxTextTransform } from './sandboxLaunchOps.js';
import { fixBriefForTicket } from './fixBriefForTicket.js';
import {
  deliverLiveFix,
  eligibleFixDelivery,
  hasPendingFixIntent,
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
 * A sandboxed session (`sandbox`) has no host CLI: its marker is emit-marker and
 * the truncation footer names no command (the inbox file is the whole brief).
 */
export function composeFixSnapshot(
  store: Store,
  ticketId: number,
  literal: CliTokens,
  sandbox?: SandboxChannel,
  mcp = false,
): { body: string; footer: string } {
  const t = getTicket(store, ticketId);
  const label = formatTicketRef(ticketId, t.key);
  const brief =
    fixBriefForTicket(store, ticketId, label) ??
    `A gate failed for ticket ${label}. Re-run the checks, fix what they report, and confirm they pass.`;
  if (sandbox) {
    const marker = renderSandboxMarkerInstruction({ runDir: sandbox.runDir, core: sandbox.core, stage: 'fix' });
    return { body: `${brief}\n\n${marker}`, footer: '… truncated' };
  }
  const marker = renderDoneMarkerInstruction(
    composeStageCommand(literal.cli, literal.db, 'fix', literal.manifest),
    t.key || String(ticketId),
    mcp ? 'fix' : undefined,
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
  sessionChannel: (ticketId: number) => DeliveryChannel;
  /** Host paths of the ticket's bridge dir, for writing a sandboxed agent's inbox brief. */
  bridgePaths?: (ticketId: number) => BridgePaths | undefined;
  /** `<globalStorage>`: a sandboxed brief's host attachment and gate-log paths are mirrored and rewritten from it. */
  storageDir: string;
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

function sandboxOf(deps: FixDeliveryWiringDeps, ticketId: number): SandboxChannel | undefined {
  const channel = deps.sessionChannel(ticketId);
  return isSandboxChannel(channel) ? channel : undefined;
}

/** Host-written inbox brief for a sandboxed agent (arch:AC-34); false = nothing to point at (retried by the sweep). */
function writeFixBrief(deps: FixDeliveryWiringDeps, ticketId: number, deliveryId: number): boolean {
  const paths = deps.bridgePaths?.(ticketId);
  const row = getFixDelivery(deps.store, deliveryId);
  if (!paths || row === null || row.ticketId !== ticketId) return false;
  try {
    const channel = sandboxOf(deps, ticketId);
    const rewrite = sandboxTextTransform({
      sandboxed: true, ticketId, storageDir: deps.storageDir, runDir: channel?.runDir, bridge: paths, attachments: listAttachments(deps.store, ticketId), log: deps.debug,
    });
    writeInboxFile(paths, inboxRef(fixPointer(deliveryId)), scrubHostCli(rewrite(row.body)).text);
    return true;
  } catch (err) {
    deps.debug(`[driver] fix delivery #${deliveryId}: inbox write refused (${err instanceof Error ? err.message : String(err)})`);
    return false;
  }
}

export function makeFixDeliveryWiring(deps: FixDeliveryWiringDeps): FixDeliveryWiring {
  const now = (): string => new Date().toISOString();
  const host: FixDeliveryHost = {
    store: deps.store,
    now,
    debug: deps.debug,
    isGraphTicket: deps.isGraphTicket,
    isLive: deps.isLive,
    routeFor: (id) => (isSandboxChannel(deps.sessionChannel(id)) ? 'typed' : messageRouteFor(deps.sessionProvider(id), CODEX_STOP_BLOCK_SUPPORTED)),
    currentLaunchId: deps.currentLaunchId,
    isRunning: (id) => getTicket(deps.store, id).agentState === 'running',
    sendPointer: (id, deliveryId, hooks): TypedSendResult => {
      if (!deps.isLive(id) || deps.isGraphTicket(id)) return 'unavailable';
      if (deps.agyBusy(id)) return 'held';
      const channel = deps.sessionChannel(id);
      if (isSandboxChannel(channel) && !writeFixBrief(deps, id, deliveryId)) return 'unavailable';
      const line = messagePointer(fixPointer(deliveryId, getTicket(deps.store, id).stageCurrent), channel);
      return deps.nudge(id, line, hooks) ? 'queued' : 'unavailable';
    },
    writeBrief: (id, deliveryId) => {
      return !isSandboxChannel(deps.sessionChannel(id)) || writeFixBrief(deps, id, deliveryId);
    },
    unsendableInbox: (id, deliveryId) => {
      if (!isSandboxChannel(deps.sessionChannel(id))) return null;
      const row = getFixDelivery(deps.store, deliveryId);
      const stuck = !deps.isLive(id) || deps.agyBusy(id) || (row !== null && hasPendingFixIntent(deps.store, row.launchId));
      if (!stuck || !writeFixBrief(deps, id, deliveryId)) return null;
      return `inbox/${inboxRef(fixPointer(deliveryId))}.md`;
    },
    retryAfterFailure: (id) => isSandboxChannel(deps.sessionChannel(id)),
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
      const { body, footer } = composeFixSnapshot(deps.store, ticketId, deps.literal(), sandboxOf(deps, ticketId), deps.sessionChannel(ticketId) === 'mcp');
      return deliverLiveFix(host, { ticketId, roundId, body, truncatedFooter: footer });
    },
    recordSeed: (ticketId, roundId, launchId) => {
      const { body, footer } = composeFixSnapshot(deps.store, ticketId, deps.literal(), sandboxOf(deps, ticketId), deps.sessionChannel(ticketId) === 'mcp');
      upsertFixDelivery(deps.store, {
        ticketId,
        recoveryRoundId: roundId,
        launchId,
        body,
        truncatedFooter: footer,
        at: now(),
      });
      const row = currentFixDelivery(deps.store, ticketId);
      if (row !== null && isSandboxChannel(deps.sessionChannel(ticketId))) writeFixBrief(deps, ticketId, row.id);
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
