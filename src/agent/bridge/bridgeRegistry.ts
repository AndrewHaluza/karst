import { bridgePaths, ensureBridgeDir, listBridgeTicketIds, removeBridgeDir, type BridgePaths } from './bridgeDir.js';
import type { BridgeAttachment } from './bridgeSink.js';

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
   */
  sweep(openTicketIds: ReadonlySet<number>, owned?: ReadonlySet<number>): Promise<BridgeSweepResult>;
}

/**
 * One poller per ticket bridge dir (arch:AC-34). `detach` (terminal closed)
 * keeps the dir — the sandbox lives on (arch:AC-32); `dispose` removes it.
 */
export function createBridgeRegistry(deps: BridgeRegistryDeps): BridgeRegistry {
  const log = (m: string): void => deps.debug?.(`[bridge] ${m}`);
  const live = new Map<number, BridgeAttachment>();

  const attach = async (ticketId: number): Promise<BridgePaths> => {
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
  const detach = async (ticketId: number): Promise<void> => {
    const attachment = live.get(ticketId);
    live.delete(ticketId);
    if (attachment) await attachment.stop();
  };
  const dispose = async (ticketId: number): Promise<void> => {
    await detach(ticketId);
    await removeBridgeDir(bridgePaths(deps.root, ticketId));
  };
  const sweep: BridgeRegistry['sweep'] = async (open, owned) => {
    const reattached: number[] = [];
    const removed: number[] = [];
    for (const id of await listBridgeTicketIds(deps.root)) {
      try {
        if (!open.has(id)) {
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
  return { attach, detach, dispose, sweep };
}
