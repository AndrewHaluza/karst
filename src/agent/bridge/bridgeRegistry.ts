import { bridgePaths, ensureBridgeDir, listBridgeTicketIds, removeBridgeDir, type BridgePaths } from './bridgeDir.js';
import type { BridgeAttachment } from './bridgeSink.js';
import type { QueuedMarker } from './markerFlow.js';

export interface BridgeRegistryDeps {
  readonly root: string;
  /** `undefined` for a ticket that no longer exists: nothing is attached. */
  readonly build: (ticketId: number, paths: BridgePaths) => BridgeAttachment | undefined;
  readonly debug?: (message: string) => void;
}

export interface BridgeSweepResult {
  readonly reattached: number[];
  readonly removed: number[];
}

export interface BridgeRegistry {
  attach(ticketId: number): Promise<BridgePaths>;
  detach(ticketId: number): Promise<void>;
  dispose(ticketId: number): Promise<void>;
  /**
   * Re-attach the dirs of open tickets, remove those of closed/unknown ones.
   * With `owned`, an open ticket outside it (another window's) is left alone.
   * `keep`: closed tickets whose sandbox is still listed: their dir stays until
   * the sandbox is verifiably removed.
   */
  sweep(openTicketIds: ReadonlySet<number>, owned?: ReadonlySet<number>, keep?: ReadonlySet<number>): Promise<BridgeSweepResult>;
  /** A sync just succeeded: re-run this ticket's transiently failed marker, if any (arch:AC-34). */
  retryPending(ticketId: number): Promise<void>;
  /** The ticket's queued done marker (reason, attempt, next retry), for the Sandbox panel. */
  markerStatus(ticketId: number): QueuedMarker | undefined;
  /** User's "Retry now": run the queued marker, or requeue a gave-up one with a fresh counter. */
  retryNow(ticketId: number): Promise<void>;
  /** Extension shutdown: stop every poller, keep every dir. */
  detachAll(): Promise<void>;
}

/**
 * One poller per ticket bridge dir (arch:AC-34). `detach` (terminal closed)
 * keeps the dir — the sandbox lives on (arch:AC-32); `dispose` removes it.
 */
export function createBridgeRegistry(deps: BridgeRegistryDeps): BridgeRegistry {
  const log = (m: string): void => deps.debug?.(`[bridge] ${m}`);
  const live = new Map<number, BridgeAttachment>();
  // One operation per ticket at a time: an attach never races another attach
  // or a detach still awaiting its poller's stop().
  const queues = new Map<number, Promise<unknown>>();
  const serial = <T>(ticketId: number, op: () => Promise<T>): Promise<T> => {
    const next = (queues.get(ticketId) ?? Promise.resolve()).then(op, op);
    const settled = next.then(() => undefined, () => undefined);
    queues.set(ticketId, settled);
    void settled.then(() => {
      if (queues.get(ticketId) === settled) queues.delete(ticketId);
    });
    return next;
  };

  const attachNow = async (ticketId: number): Promise<BridgePaths> => {
    const paths = bridgePaths(deps.root, ticketId);
    if (live.has(ticketId)) return paths;
    await ensureBridgeDir(paths);
    const attachment = deps.build(ticketId, paths);
    if (attachment) {
      live.set(ticketId, attachment);
      attachment.start();
    }
    return paths;
  };
  const detachNow = async (ticketId: number): Promise<void> => {
    const attachment = live.get(ticketId);
    live.delete(ticketId);
    if (attachment) await attachment.stop();
  };
  const attach = (ticketId: number): Promise<BridgePaths> => serial(ticketId, () => attachNow(ticketId));
  const detach = (ticketId: number): Promise<void> => serial(ticketId, () => detachNow(ticketId));
  const dispose = (ticketId: number): Promise<void> =>
    serial(ticketId, async () => {
      await detachNow(ticketId);
      await removeBridgeDir(bridgePaths(deps.root, ticketId));
    });
  const detachAll = async (): Promise<void> => {
    await Promise.all([...live.keys()].map((id) => detach(id)));
  };
  const sweep: BridgeRegistry['sweep'] = async (open, owned, keep) => {
    const reattached: number[] = [];
    const removed: number[] = [];
    for (const id of await listBridgeTicketIds(deps.root)) {
      try {
        if (!open.has(id)) {
          // A closed ticket's events are moot, but its dir goes only with its sandbox (arch:AC-37).
          if (keep?.has(id)) continue;
          await dispose(id);
          removed.push(id);
        } else if (!owned || owned.has(id)) {
          await attach(id);
          reattached.push(id);
        }
      } catch (err) {
        log(`sweep skipped ticket ${id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { reattached, removed };
  };
  const retryPending = async (ticketId: number): Promise<void> => {
    await live.get(ticketId)?.retryPending?.();
  };
  const markerStatus = (ticketId: number): QueuedMarker | undefined => live.get(ticketId)?.markerStatus?.();
  const retryNow = async (ticketId: number): Promise<void> => {
    await live.get(ticketId)?.retryNow?.();
  };
  return { attach, detach, dispose, sweep, detachAll, retryPending, markerStatus, retryNow };
}
