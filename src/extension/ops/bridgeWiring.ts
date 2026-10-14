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
import { findTicketById } from '../../store/tickets.js';
import { createMarkerRunner, type MarkerSpawn } from './markerRunner.js';

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
    const facts = { nodePath: deps.nodePath, cliEntry, dbPath, manifestPath, ticketKey: ticket.key || String(ticketId), cwd: worktreePath };
    return (deps.attach ?? createBridgeAttachment)({
      paths,
      expect: liveExpectation(deps, ticketId, worktreePath),
      dispatch: (payload) => dispatch(deps, ticketId, payload, log),
      runMarker: deps.spawn ? createMarkerRunner(facts, deps.spawn) : createMarkerRunner(facts),
      intervalMs: BRIDGE_POLL_INTERVAL_MS,
      ...(deps.debug ? { debug: deps.debug } : {}),
    });
  };
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
