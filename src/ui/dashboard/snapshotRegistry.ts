import { existsSync, realpathSync } from 'node:fs';
import type { Store } from '../../store/db.js';
import type { LogError } from '../../logging/logger.js';
import type { GraphActionTarget } from '../../model/inside/graph.js';
import { listWorktreesByTicket } from '../../store/dashboard.js';
import {
  InsideActionRegistry,
  dispatchInsideAction,
  type InsideActionHost,
  type InsideActionTarget,
} from './insideActions.js';
import type { InsideActionResult } from './messages.js';

/**
 * How long a superseded snapshot's action ids stay dispatchable — the window a
 * click already in flight when a repaint landed has to survive. Sized for a
 * webview→host round trip, not for the repaint cadence.
 */
export const ACTION_GRACE_MS = 5000;

/** Memory bound on the grace list; the time window above is what actually decides. */
const MAX_GRACE_DEPTH = 10;

/** Store + host + error sink the registry needs to dispatch an opaque action id. */
export interface DispatchDeps {
  store: Store;
  host: InsideActionHost;
  logError: LogError;
}

/**
 * The snapshot-scoped capability registry for every open ticket, plus the grace
 * window that keeps a just-superseded snapshot dispatchable for one round trip.
 *
 * A fresh action registry is minted PER SNAPSHOT: every real state push is
 * authoritative, so the ids it mints are the only live capabilities. A LIVE
 * repaint is the SAME snapshot re-read, so it REUSES the current registry — the
 * ids the webview already holds stay live (see `DashboardManager.pushSnapshot`
 * for the full rationale). A superseded registry stays dispatchable for a short
 * wall-clock window (`ACTION_GRACE_MS`), bounded by `MAX_GRACE_DEPTH`, so a
 * click posted against the render on screen survives a repaint landing while
 * the message is in flight.
 */
export class SnapshotRegistry {
  private readonly registries = new Map<number, InsideActionRegistry>();
  /**
   * The registries of superseded snapshots, newest last, with the moment each
   * was superseded — the grace window for a click already in flight when a
   * repaint replaced the render it was posted from.
   *
   * Bounded by TIME (`ACTION_GRACE_MS`), not by a generation count: what the
   * window has to cover is one webview→host round trip, and tying it to "the
   * previous snapshot" made its real length the tick period — so a faster tick
   * would silently shorten it and a slower one stretch it. `MAX_GRACE_DEPTH`
   * is the memory bound only.
   */
  private readonly priorRegistries = new Map<
    number,
    Array<{ registry: InsideActionRegistry; supersededAt: number }>
  >();
  private readonly generations = new Map<number, number>();

  /**
   * The registry a snapshot should mint ids against: a fresh one for a real
   * push (or the first push), the CURRENT one for a live repaint.
   */
  beginSnapshot(ticketId: number, supplemental: boolean): InsideActionRegistry {
    const existing = this.registries.get(ticketId);
    if (!supplemental && existing) return existing;
    const generation = (this.generations.get(ticketId) ?? 0) + 1;
    this.generations.set(ticketId, generation);
    const registry = new InsideActionRegistry(generation, ticketId);
    if (existing) {
      const grace = this.priorRegistries.get(ticketId) ?? [];
      grace.push({ registry: existing, supersededAt: Date.now() });
      this.priorRegistries.set(ticketId, grace);
    }
    this.pruneGrace(ticketId);
    this.registries.set(ticketId, registry);
    return registry;
  }

  /** The CURRENT snapshot-scoped registry for a ticket, if one was minted. */
  current(ticketId: number): InsideActionRegistry | undefined {
    return this.registries.get(ticketId);
  }

  /**
   * Dispatch one opaque inside action id against the ticket's CURRENT action
   * registry. Rejects (logged) when the target fails its checks; unknown ids
   * are silently dropped — a stale or foreign id is not a fault to surface.
   * Returns the terminal outcome so the message pump can report the REAL
   * result to the webview (UI-R13): a rejected or stale dispatch is never
   * acknowledged as success.
   */
  dispatch(ticketId: number, actionId: string, deps: DispatchDeps): InsideActionResult {
    // Current snapshot first, then the ONE it superseded: an id only ever
    // resolves against its own generation, so trying both is a grace window,
    // not a widening of what a given id can reach.
    const registry = this.registries.get(ticketId);
    if (!registry) return { ok: false, message: 'This action is no longer available.' };
    const dispatchAgainst = (target: InsideActionRegistry): ReturnType<typeof dispatchInsideAction> =>
      dispatchInsideAction(deps.store, target, actionId, {
        host: deps.host,
        worktreeForRepo: (repo) =>
          listWorktreesByTicket(deps.store, ticketId).find((w) => w.repo === repo)?.path,
        fs: { existsSync, realpathSync },
      });
    let outcome = dispatchAgainst(registry);
    if (outcome.outcome === 'unknown') {
      this.pruneGrace(ticketId);
      // Newest first: an id resolves only against its own generation, so this
      // is a grace window, never a widening of what a given id can reach.
      const grace = this.priorRegistries.get(ticketId) ?? [];
      for (let i = grace.length - 1; i >= 0 && outcome.outcome === 'unknown'; i -= 1) {
        outcome = dispatchAgainst(grace[i]!.registry);
      }
    }
    if (outcome.outcome === 'rejected') {
      deps.logError(`karst: inside action rejected: ${outcome.reason}`, undefined);
      // The reason is host diagnostic prose and may name a path — never send it
      // to the webview. The user-facing message is a fixed string.
      return { ok: false, message: 'This action could not be run.' };
    }
    if (outcome.outcome === 'unknown') {
      // A stale or foreign capability is not a success.
      return { ok: false, message: 'This action is no longer available.' };
    }
    return { ok: true };
  }

  /** The panel's action capabilities die with it — a disposed id never dispatches. */
  clear(ticketId: number): void {
    this.registries.get(ticketId)?.dispose();
    this.registries.delete(ticketId);
    for (const entry of this.priorRegistries.get(ticketId) ?? []) entry.registry.dispose();
    this.priorRegistries.delete(ticketId);
    this.generations.delete(ticketId);
  }

  /**
   * Drop every superseded registry past the grace window (or past the depth
   * bound), disposing it — a capability that outlives its window is exactly
   * what the snapshot scoping exists to prevent.
   */
  private pruneGrace(ticketId: number): void {
    const grace = this.priorRegistries.get(ticketId);
    if (!grace) return;
    const cutoff = Date.now() - ACTION_GRACE_MS;
    while (grace.length > 0 && (grace[0]!.supersededAt < cutoff || grace.length > MAX_GRACE_DEPTH)) {
      grace.shift()!.registry.dispose();
    }
    if (grace.length === 0) this.priorRegistries.delete(ticketId);
  }
}

/** An absent host resolves nothing: every dispatch is unknown/rejected, never acted on. */
export const NOOP_INSIDE_HOST: InsideActionHost = {
  openFile: () => undefined,
  openPr: () => undefined,
  openCommit: () => undefined,
  resumeStage: () => undefined,
  openFullEvidence: () => undefined,
  openBoundedEvidence: () => undefined,
  openSession: () => undefined,
  graphOpenSession: () => undefined,
  graphStop: () => undefined,
  graphResume: () => undefined,
  graphRestart: () => undefined,
  graphReplan: () => undefined,
  graphConfirm: () => undefined,
  graphMarkImpl: () => undefined,
  graphDiscardNode: () => undefined,
  graphEditOverride: () => undefined,
  retryShipRepo: () => undefined,
};

/** The graph projection's ticket-less target, stamped with the registry's
 *  ticket — the ONLY place the projection's targets become dispatchable
 *  capabilities. Exhaustive over the closed `GraphActionTarget` union. */
export function toRegisteredGraphTarget(
  target: GraphActionTarget,
  ticketId: number,
): InsideActionTarget {
  switch (target.kind) {
    case 'graph-open-session':
      return { kind: 'graph-open-session', ticketId, session: target.session };
    case 'graph-stop':
      return { kind: 'graph-stop', ticketId, graphRunId: target.graphRunId };
    case 'graph-resume':
      return { kind: 'graph-resume', ticketId, graphRunId: target.graphRunId };
    case 'graph-restart':
      return { kind: 'graph-restart', ticketId, graphRunId: target.graphRunId };
    case 'graph-replan':
      return { kind: 'graph-replan', ticketId, graphRunId: target.graphRunId };
    case 'graph-confirm':
      return { kind: 'graph-confirm', ticketId, graphRunId: target.graphRunId };
    case 'graph-mark-impl':
      return { kind: 'graph-mark-impl', ticketId, graphRunId: target.graphRunId };
    case 'graph-discard-node':
      return { kind: 'graph-discard-node', ticketId, nodeRunId: target.nodeRunId };
    case 'graph-edit-override':
      return { kind: 'graph-edit-override', ticketId, nodeRunId: target.nodeRunId };
  }
}
