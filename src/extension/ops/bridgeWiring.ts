import type { BridgePaths } from '../../agent/bridge/bridgeDir.js';
import { createBridgeAttachment, type BridgeAttachment } from '../../agent/bridge/bridgeSink.js';
import type { BridgeExpectation } from '../../agent/bridge/bridgeVerifier.js';
import type { HookChannelRecorder } from '../../diagnostics/hookChannel.js';
import {
  dispatchHook,
  type HookPayload,
  type NotifyTicket,
  type SessionProviderFor,
  type ShouldApplyHookState,
  type TurnTracker,
} from '../../hooks/dispatch.js';
import type { StageKey } from '../../model/types.js';
import type { Store } from '../../store/db.js';
import { listWorktreesByTicket } from '../../store/dashboard.js';
import { findTicketById, getSessionLaunchId } from '../../store/tickets.js';
import type { MarkerFailure } from '../../agent/bridge/markerFlow.js';
import { ackFixDeliveryRef } from './fixDeliveryOps.js';
import { createMarkerRunner, type MarkerSpawn } from './markerRunner.js';
import type { EnsureSyncResult } from './sandboxSyncOps.js';

/** How often a ticket's bridge file is tailed (arch:AC-34). */
export const BRIDGE_POLL_INTERVAL_MS = 250;

/** The SAME closures the HTTP hook endpoint is built with, so the generation barrier and recorder are shared. */
export interface HookDispatchClosures {
  readonly notify?: NotifyTicket;
  readonly shouldApplyState?: ShouldApplyHookState;
  readonly sessionProviderFor?: SessionProviderFor;
  readonly recorder?: HookChannelRecorder;
  readonly debug?: (message: string) => void;
  readonly tracker?: TurnTracker;
}

export interface BridgeBuildDeps {
  readonly store: Store;
  readonly hookDispatch: HookDispatchClosures;
  /** The ticket's current hook launch generation, read per line. */
  readonly launchIdFor: (ticketId: number) => string | undefined;
  /** The CLI facts a host session's marker uses, read at attach time. */
  readonly cli: () => { readonly cliEntry: string; readonly dbPath: string; readonly manifestPath: string | undefined };
  readonly nodePath: string;
  readonly debug?: (message: string) => void;
  /** A marker failure is a WARN, never DEBUG-only (arch:AC-34). */
  readonly warn?: (message: string) => void;
  /** Shows the user a failed done marker; `diverged` = a Needs-you blocker with Open sync diff. */
  readonly notifyFailure?: (ticketId: number, message: string, diverged: boolean, gaveUp: boolean) => void;
  /** Fast-forwards a sandboxed ticket's host worktree before its stage CLI runs; a host ticket is a no-op (arch:AC-32). */
  readonly ensureSynced?: (ticketId: number) => Promise<EnsureSyncResult>;
  readonly spawn?: MarkerSpawn;
  readonly attach?: typeof createBridgeAttachment;
}

/** `BridgeRegistry.build`: `undefined` when the ticket cannot be attached. */
export function makeBridgeBuild(
  deps: BridgeBuildDeps,
): (ticketId: number, paths: BridgePaths) => BridgeAttachment | undefined {
  const log = (m: string): void => deps.debug?.(`[bridge] ${m}`);
  return (ticketId, paths) => {
    const skip = (why: string): undefined => {
      log(`ticket ${ticketId} not attached: ${why}`);
      return undefined;
    };
    const ticket = findTicketById(deps.store, ticketId);
    if (!ticket) return skip('no such ticket');
    const worktreePath = listWorktreesByTicket(deps.store, ticketId)[0]?.path;
    if (!worktreePath) return skip('no worktree');
    const { cliEntry, dbPath, manifestPath } = deps.cli();
    if (!manifestPath) return skip('manifest unresolved');
    const ticketKey = ticket.key || String(ticketId);
    const facts = {
      nodePath: deps.nodePath, cliEntry, dbPath, manifestPath, ticketKey, cwd: worktreePath,
      ...(deps.ensureSynced ? { ensureSynced: () => deps.ensureSynced!(ticketId) } : {}),
    };
    return (deps.attach ?? createBridgeAttachment)({
      paths,
      expect: liveExpectation(deps, ticketId, worktreePath),
      dispatch: (payload) => dispatch(deps, ticketId, payload, log),
      runMarker: deps.spawn ? createMarkerRunner(facts, deps.spawn) : createMarkerRunner(facts),
      intervalMs: BRIDGE_POLL_INTERVAL_MS,
      onAck: (ref) => {
        const claimed = ackFixDeliveryRef(deps.store, ticketId, ref, new Date().toISOString());
        log(`ticket ${ticketId} ack ${ref}: ${claimed ? 'delivery marked read' : 'ignored (not a pending delivery of this ticket)'}`);
      },
      onMarkerFailure: (failure) => markerFailed(deps, ticketId, ticketKey, failure),
      ...(deps.debug ? { debug: deps.debug } : {}),
    });
  };
}

function markerFailed(deps: BridgeBuildDeps, ticketId: number, ticketKey: string, failure: MarkerFailure): void {
  const message = `Karst: ${ticketKey} ${failure.stage} done marker failed: ${failure.reason}`;
  deps.warn?.(message);
  deps.notifyFailure?.(ticketId, message, failure.diverged, failure.gaveUp === true);
}

function liveExpectation(deps: BridgeBuildDeps, ticketId: number, worktreePath: string): BridgeExpectation {
  const current = () => findTicketById(deps.store, ticketId);
  return {
    ticketId,
    worktreePath,
    get launchId() {
      return deps.launchIdFor(ticketId);
    },
    stage: () => (current()?.stageCurrent ?? null) as StageKey | null,
    sessionId: () => current()?.sessionId ?? undefined,
    sessionLaunchId: () => getSessionLaunchId(deps.store, ticketId),
  };
}

function dispatch(deps: BridgeBuildDeps, ticketId: number, payload: HookPayload, log: (m: string) => void): void {
  const c = deps.hookDispatch;
  try {
    dispatchHook(deps.store, payload, c.notify, c.shouldApplyState, c.sessionProviderFor, c.recorder, c.debug, c.tracker);
  } catch (err) {
    log(`ticket ${ticketId} dispatch failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Tickets whose bridge may live: not archived, not done. */
export function openBridgeTicketIds(store: Store): Set<number> {
  const rows = store.db
    .prepare("SELECT id FROM tickets WHERE archived_at IS NULL AND (stage_current IS NULL OR stage_current != 'done')")
    .all() as { id: number }[];
  return new Set(rows.map((r) => r.id));
}
