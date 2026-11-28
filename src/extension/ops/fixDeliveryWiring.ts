import type { Store } from '../../store/db.js';
import type { CliTokens } from '../../agent/cliEnv.js';
import type { NudgeHooks } from '../../ui/nudgeQueue.js';
import { fixPointer, inboxRef, isSandboxChannel, messagePointer, type DeliveryChannel, type SandboxChannel } from '../../workflow/messageDelivery.js';
import { getTicket, setAgentState } from '../../store/tickets.js';
import {
  claimPointed,
  claimRead,
  nextUnreadDelivery,
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
  closeStaleDeliveries,
  eligibleFixDelivery,
  hasPendingFixIntent,
  isThenable,
  type Awaitable,
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
    fixBriefForTicket(store, ticketId, label, true) ??
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
  /** This window controls the ticket (arch:GLOBAL). Absent = every ticket of the project. Only the controlling window escalates: `isLive` is false for a session another window holds. */
  owns?: (ticketId: number) => boolean;
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
  /**
   * Copy one bridge file a sandboxed agent must read to its ssh remote (D556).
   * Absent, or a non-ssh placement, is a no-op success. The sync boolean shape
   * is kept for host/sbx/docker callers.
   */
  mirror?: (ticketId: number, rel: string, body: string) => Awaitable<{ readonly ok: true } | { readonly ok: false; readonly reason: string }>;
  /**
   * Copy the host `attachments/` and `logs/` copies a brief names to the ssh
   * remote (D556 edit 5). Absent, or a non-ssh placement, is a no-op success.
   */
  mirrorDirs?: (ticketId: number) => Awaitable<{ readonly ok: true } | { readonly ok: false; readonly reason: string }>;
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
  deliver: (ticketId: number, roundId: number | null) => Awaitable<boolean>;
  /**
   * Conflict round (@arch:AP-01), live path: store the brief as a `conflict` row and point the live agent at it, like a
   * fix round. False when no session could take it (the caller seeds a launch instead).
   */
  deliverConflict: (ticketId: number, repo: string, brief: string) => Awaitable<boolean>;
  /** Conflict round, seed path: the launch seed carries the brief, so the row is read at once (`delivered_via='seed'`). */
  recordConflictSeed: (ticketId: number, repo: string, brief: string) => void;
  /** The pointer round of a delivery the hook is about to name: `conflict` words it and drops the marker clause. */
  roundOf: (deliveryId: number) => 'fix' | 'conflict';
  /** Seed path: store the snapshot for a prepared fix launch (call inside the intent's transaction). */
  recordSeed: (ticketId: number, roundId: number, launchId: string) => Awaitable<void>;
  /** Seed path, untracked round: the seed carries the newer brief, so older unread rows go stale. */
  supersedeUnread: (ticketId: number) => void;
  /** Delivery guard: type the pointer for the snapshot bound to an unconfirmed seed launch. */
  pointAtLaunch: (ticketId: number, launchId: string) => Awaitable<'sent' | 'unsendable' | 'no-row'>;
  /** Hook channel: the delivery id the turn-end reply may point at, if any. */
  eligible: (ticketId: number) => number | null;
  /** A current row is armed and not yet read or pointed, eligible or not: the hook log names it when `eligible` is null. */
  armed: (ticketId: number) => boolean;
  claimPointed: (ticketId: number, deliveryId: number) => boolean;
}

function sandboxOf(deps: FixDeliveryWiringDeps, ticketId: number): SandboxChannel | undefined {
  const channel = deps.sessionChannel(ticketId);
  return isSandboxChannel(channel) ? channel : undefined;
}

/**
 * Host-written inbox brief for a sandboxed agent (arch:AC-34), mirrored to an
 * ssh remote after the host write and BEFORE any nudge (D556). False = nothing
 * to point at (the host write or the remote mirror failed; the sweep retries).
 */
function writeFixBrief(deps: FixDeliveryWiringDeps, ticketId: number, deliveryId: number): Awaitable<boolean | 'mirror-refused'> {
  const paths = deps.bridgePaths?.(ticketId);
  const row = getFixDelivery(deps.store, deliveryId);
  if (!paths || row === null || row.ticketId !== ticketId) return false;
  try {
    const channel = sandboxOf(deps, ticketId);
    const rewrite = sandboxTextTransform({
      sandboxed: true, ticketId, storageDir: deps.storageDir, runDir: channel?.runDir, bridge: paths, attachments: listAttachments(deps.store, ticketId), log: deps.debug,
    });
    const ref = inboxRef(fixPointer(deliveryId));
    const body = scrubHostCli(rewrite(row.body)).text;
    writeInboxFile(paths, ref, body);
    const mirror = deps.mirror?.(ticketId, `inbox/${ref}.md`, body);
    if (mirror === undefined) return true;
    const settle = (result: { readonly ok: true } | { readonly ok: false; readonly reason: string }): boolean | 'mirror-refused' => {
      if (result.ok) return true;
      deps.debug(`[driver] fix delivery #${deliveryId}: remote mirror refused (${result.reason})`);
      return 'mirror-refused';
    };
    const reject = (err: unknown): 'mirror-refused' => {
      deps.debug(`[driver] fix delivery #${deliveryId}: remote mirror failed (${err instanceof Error ? err.message : String(err)})`);
      return 'mirror-refused';
    };
    /** The attachment/gate-log copies the body names (loaded by the transform above) must exist remotely too. */
    const settleDirs = (written: boolean | 'mirror-refused'): Awaitable<boolean | 'mirror-refused'> => {
      if (written !== true || deps.mirrorDirs === undefined) return written;
      const dirs = deps.mirrorDirs(ticketId);
      const onDirs = (result: { readonly ok: true } | { readonly ok: false; readonly reason: string }): boolean | 'mirror-refused' => {
        if (result.ok) return true;
        deps.debug(`[driver] fix delivery #${deliveryId}: remote attachment/log mirror refused (${result.reason})`);
        return 'mirror-refused';
      };
      const onDirsReject = (err: unknown): 'mirror-refused' => {
        deps.debug(`[driver] fix delivery #${deliveryId}: remote attachment/log mirror failed (${err instanceof Error ? err.message : String(err)})`);
        return 'mirror-refused';
      };
      return isThenable(dirs) ? Promise.resolve(dirs).then(onDirs, onDirsReject) : onDirs(dirs);
    };
    return isThenable(mirror) ? mirror.then(settle, reject).then(settleDirs) : settleDirs(settle(mirror));
  } catch (err) {
    deps.debug(`[driver] fix delivery #${deliveryId}: inbox write refused (${err instanceof Error ? err.message : String(err)})`);
    return false;
  }
}

export function makeFixDeliveryWiring(deps: FixDeliveryWiringDeps): FixDeliveryWiring {
  const now = (): string => new Date().toISOString();
  const roundOf = (deliveryId: number): 'fix' | 'conflict' => getFixDelivery(deps.store, deliveryId)?.kind ?? 'fix';
  const host: FixDeliveryHost = {
    store: deps.store,
    now,
    debug: deps.debug,
    isGraphTicket: deps.isGraphTicket,
    isLive: deps.isLive,
    routeFor: (id) => (isSandboxChannel(deps.sessionChannel(id)) ? 'typed' : messageRouteFor(deps.sessionProvider(id), CODEX_STOP_BLOCK_SUPPORTED)),
    currentLaunchId: deps.currentLaunchId,
    isRunning: (id) => getTicket(deps.store, id).agentState === 'running',
    isIdle: (id) => getTicket(deps.store, id).agentState === 'idle',
    sendPointer: (id, deliveryId, hooks, opts): Awaitable<TypedSendResult> => {
      const unavailable: TypedSendResult = 'unavailable';
      if (!deps.isLive(id) || deps.isGraphTicket(id)) return unavailable;
      if (deps.agyBusy(id)) return 'held';
      const channel = deps.sessionChannel(id);
      const send = (): TypedSendResult => {
        const line = messagePointer(fixPointer(deliveryId, getTicket(deps.store, id).stageCurrent, roundOf(deliveryId)), channel);
        return deps.nudge(id, line, hooks) ? 'queued' : unavailable;
      };
      if (!isSandboxChannel(channel) || opts?.briefWritten === true) return send();
      // The remote agent must have its own brief BEFORE the pointer: a refused
      // or async mirror holds the line until it resolves (D556).
      const written = writeFixBrief(deps, id, deliveryId);
      const afterWrite = (ok: boolean | 'mirror-refused'): TypedSendResult => (ok === true ? send() : unavailable);
      return isThenable(written) ? written.then(afterWrite) : afterWrite(written);
    },
    writeBrief: (id, deliveryId) => {
      return !isSandboxChannel(deps.sessionChannel(id)) || writeFixBrief(deps, id, deliveryId);
    },
    unsendableInbox: (id, deliveryId): Awaitable<string | null> => {
      if (deps.owns?.(id) === false) return null;
      if (!isSandboxChannel(deps.sessionChannel(id))) return null;
      const row = getFixDelivery(deps.store, deliveryId);
      const stuck = !deps.isLive(id) || deps.agyBusy(id) || (row !== null && hasPendingFixIntent(deps.store, row.launchId));
      if (!stuck) return null;
      const file = `inbox/${inboxRef(fixPointer(deliveryId))}.md`;
      const written = writeFixBrief(deps, id, deliveryId);
      // A written brief and a host file whose REMOTE mirror failed (D556) both
      // name the file: a human must still be asked after the unsendable window.
      // Only a missing bridge dir has nothing at all to name (the sweep asks only for a listed row).
      const settle = (): string | null => (deps.bridgePaths?.(id) !== undefined ? file : null);
      return isThenable(written) ? written.then(settle) : settle();
    },
    hostUnsendable: (id, deliveryId) => {
      if (deps.owns?.(id) === false) return null;
      if (isSandboxChannel(deps.sessionChannel(id))) return null;
      if (!deps.isLive(id)) return 'no live agent session in this window';
      const row = getFixDelivery(deps.store, deliveryId);
      return row !== null && hasPendingFixIntent(deps.store, row.launchId) ? 'the fix launch is still starting' : null;
    },
    // Host and sandbox alike: an escalated pointer must still reach the agent once it is live again (arch:AC-37).
    retryAfterFailure: () => true,
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
    deliverConflict: (ticketId, repo, brief) => deliverLiveFix(host, { ticketId, roundId: null, body: brief, truncatedFooter: '… truncated', kind: 'conflict', repo }),
    recordConflictSeed: (ticketId, repo, brief) => {
      const at = now();
      const id = upsertFixDelivery(deps.store, { ticketId, recoveryRoundId: null, launchId: deps.currentLaunchId(ticketId) ?? null, body: brief, truncatedFooter: '… truncated', at, kind: 'conflict', repo });
      claimRead(deps.store, id, 'seed', at);
    },
    roundOf,
    recordSeed: (ticketId, roundId, launchId): Awaitable<void> => {
      const { body, footer } = composeFixSnapshot(deps.store, ticketId, deps.literal(), sandboxOf(deps, ticketId), deps.sessionChannel(ticketId) === 'mcp');
      const id = upsertFixDelivery(deps.store, {
        ticketId,
        recoveryRoundId: roundId,
        launchId,
        body,
        truncatedFooter: footer,
        at: now(),
      });
      if (!isSandboxChannel(deps.sessionChannel(ticketId))) return;
      const written = writeFixBrief(deps, ticketId, id);
      if (isThenable(written)) return written.then(() => undefined);
    },
    supersedeUnread: (ticketId) => {
      supersedeFixDeliveries(deps.store, ticketId, now());
    },
    pointAtLaunch: (ticketId, launchId): Awaitable<'sent' | 'unsendable' | 'no-row'> => {
      const row = openFixDeliveryForLaunch(deps.store, launchId);
      if (row === null) return 'no-row';
      const result = host.sendPointer(ticketId, row.id, {
        onTyped: () => void claimPointed(deps.store, row.id, now()),
      });
      const settle = (sent: TypedSendResult): 'sent' | 'unsendable' => (sent === 'queued' ? 'sent' : 'unsendable');
      return isThenable(result) ? result.then(settle) : settle(result);
    },
    eligible: (ticketId) => eligibleFixDelivery(host, ticketId)?.id ?? null,
    armed: (ticketId) => {
      closeStaleDeliveries(host, ticketId);
      const row = nextUnreadDelivery(deps.store, ticketId, true);
      return row !== null && row.armedAt !== null && row.pointedAt === null && row.readAt === null && row.pointerFailedAt === null;
    },
    claimPointed: (ticketId, deliveryId) => {
      void ticketId;
      return claimPointed(deps.store, deliveryId, now());
    },
  };
}
