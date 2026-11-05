import type { OpenSessionOptions } from '../ui/session.js';
import type { Store } from '../store/db.js';
import { memoryWaitOwner } from '../store/memoryQueue.js';
import type { Inventory } from '../runtime/resourceInventory.js';
import { makeMemoryQueue, type MemoryQueue } from './ops/memoryQueueOps.js';
import { makePressureWatch, type SandboxFootprint } from '../runtime/memoryPressure.js';
import type { Notify } from './ops/notify.js';
import type { Manifest } from '../manifest/types.js';
import { readFreeHostMemory } from '../agent/sbx/hostMemory.js';
import { totalmem } from 'node:os';
import { resolveMinFreeBytes, resolveSbxMemory } from '../agent/sbx/sbxMemory.js';
import { SBX_CORES } from '../agent/sbx/sbxRunner.js';
import { NODE_SBX_PROCESS } from '../agent/sbx/sbxProcess.js';

export interface MemoryBindingDeps {
  readonly store: Store;
  readonly notify: Notify;
  /** The current manifest: `sandboxMemory.sbxMinFree` is the admission threshold, read per sweep. */
  readonly manifest: () => Manifest | undefined;
  /** Free host memory (tests); default `vm_stat` / `os.freemem`. */
  readonly freeBytes?: () => Promise<number>;
  /** Relaunches the ticket through the normal open-session path (the same one an interactive launch takes). */
  readonly openSession: (ticketId: number, options?: OpenSessionOptions) => Promise<unknown>;
  /** This window's project id: the sweep never starts another project's ticket. */
  readonly projectId?: () => number | undefined;
  /** Pause between two queue starts (a booting VM needs a moment to show in free memory). Default 45 s. */
  readonly settleMs?: number;
  readonly label: (ticketId: number) => string;
  /** Repaints the sidebar and the dashboard for a ticket whose waiting state changed. */
  readonly refresh: (ticketId: number) => void;
  readonly inventory: () => Inventory | null | undefined;
  readonly ownedSessions: () => Iterable<number>;
  readonly stopSandbox: (ticketId: number) => Promise<void>;
  readonly debug: (line: string) => void;
  readonly sweepMs: number;
  readonly pressureMs?: number;
  /** Is the extension host with this pid alive? Default `process.kill(pid, 0)`. */
  readonly isAlive?: (owner: string) => boolean;
  /** This window's owner mark. Default the extension host pid. */
  readonly owner?: string;
}

export interface MemoryBinding {
  /** Gate a sandbox launch: true → go ahead; false → the ticket is queued ('Waiting for memory'), with Start anyway / Cancel offered. */
  admitLaunch(ticketId: number, options?: OpenSessionOptions): Promise<boolean>;
  dispose(): void;
}

/** Wires the host-memory queue sweep and the pressure warning to the extension (arch:AUTOSTART pattern, arch:AC-37). */
export function bindMemory(d: MemoryBindingDeps): MemoryBinding {
  const owner = d.owner ?? String(process.pid);
  const isAlive = d.isAlive ?? ((o: string): boolean => {
    try { process.kill(Number(o), 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
  });
  const freeBytes = d.freeBytes ?? ((): Promise<number> => readFreeHostMemory(NODE_SBX_PROCESS));
  const minFreeBytes = (): number => resolveMinFreeBytes(d.manifest()?.sandboxMemory?.sbxMinFree);
  /** Tickets the sweep (or Start anyway) just admitted: their relaunch skips the check once. */
  const admitted = new Set<number>();
  /** The options each queued launch came with (seed prompt, reveal, recovery…), replayed when the sweep relaunches it. */
  const pending = new Map<number, OpenSessionOptions>();
  /** Tickets whose sbx launch went through this window's gate: only these may be named by the pressure warning's fallback. */
  const sbxTickets = new Set<number>();
  const queue: MemoryQueue = makeMemoryQueue({
    store: d.store, freeBytes, minFreeBytes, notify: d.notify, label: d.label, debug: d.debug,
    ...(d.projectId ? { projectId: d.projectId } : {}), hasSession: (id) => [...d.ownedSessions()].includes(id), settleMs: d.settleMs ?? 45_000,
    owner,
    // This window holds the launch options of its own queued tickets; a live owner's row is left to that window,
    // and a row whose owner is gone (reload, closed window) is adopted with default options so it never blocks the line.
    canStart: (id) => {
      if (pending.has(id)) return true;
      const o = memoryWaitOwner(d.store, id);
      return o === null || o === owner || !isAlive(o); // o === owner: a row this window adopted earlier
    },
    start: async (id) => {
      admitted.add(id);
      try {
        await d.openSession(id, pending.get(id)); // after a reload `pending` is empty: the relaunch uses the default options
        return { ok: true };
      } finally {
        admitted.delete(id);
        pending.delete(id);
        d.refresh(id);
      }
    },
  });
  const sweepTimer = setInterval(() => {
    void queue.sweep().then((started) => { if (started !== null) d.refresh(started); }).catch((e: unknown) => d.debug(`[memory-queue] sweep failed: ${String(e)}`));
  }, d.sweepMs);
  // Biggest sandbox by the Resources sampler: container rows, else the VM overhead split over the owned sessions.
  const pressure = makePressureWatch({
    freeBytes,
    minFreeBytes,
    sandboxes: (): SandboxFootprint[] => {
      const inv = d.inventory();
      if (!inv) return [];
      const rows = inv.attributed.filter((r) => r.kind === 'container' && r.ticketId !== null && r.cost);
      if (rows.length > 0) return rows.map((r) => ({ name: r.label ?? `ticket ${r.ticketId}`, ticketId: r.ticketId!, footprintBytes: r.cost!.rssBytes }));
      const ids = [...d.ownedSessions()].filter((id) => sbxTickets.has(id)); // host sessions are not sandboxes
      const vm = inv.vmOverhead;
      return vm && ids.length > 0 ? ids.map((id) => ({ name: d.label(id), ticketId: id, footprintBytes: vm.rssBytes / ids.length })) : [];
    },
    warn: async (message) => (await d.notify.infoActions?.(message, ['Stop'])) === 'Stop',
    stop: (b) => d.stopSandbox(b.ticketId).catch((e: unknown) => d.notify.warn(`Karst: could not stop ${b.name}: ${String(e).slice(0, 300)}`)),
  });
  const pressureTimer = setInterval(() => void pressure.tick().catch((e: unknown) => d.debug(`[memory-pressure] tick failed: ${String(e)}`)), d.pressureMs ?? 30_000);
  return {
    admitLaunch: async (ticketId, options) => {
      sbxTickets.add(ticketId);
      if (admitted.delete(ticketId)) return true;
      const admission = await queue.admit(ticketId);
      if (admission.admitted) { pending.delete(ticketId); return true; }
      if (pending.has(ticketId)) { d.refresh(ticketId); return false; } // already queued here: keep its options, no second notice
      pending.set(ticketId, options ?? {}); // also marks this window as the one that queued it (canStart)
      d.refresh(ticketId);
      void d.notify.infoActions?.(`Karst: ${d.label(ticketId)}: ${admission.note}`, ['Start anyway', 'Cancel']).then(async (choice) => {
        if (choice === 'Cancel') { queue.cancel(ticketId); pending.delete(ticketId); }
        else if (choice === 'Start anyway') {
          const r = await queue.startAnyway(ticketId);
          if (!r.ok) d.notify.warn(`Karst: ${d.label(ticketId)} could not start: ${r.message.slice(0, 300)}`);
        }
        d.refresh(ticketId);
      }).catch((e: unknown) => d.debug(`[memory-queue] launch notice failed: ${String(e)}`));
      return false;
    },
    dispose: () => { clearInterval(sweepTimer); clearInterval(pressureTimer); },
  };
}

/** `sbx run --memory` for this host: manifest override or the 40% default (sbxMemory.ts). */
export function hostSbxMemory(override?: string): string {
  return resolveSbxMemory(totalmem(), override);
}

/** Only sbx launches take the host-memory gate; Docker sandboxes have their own limits (arch:CONCURRENCY). */
export function isSbxLaunch(core: string | null | undefined): boolean {
  return core != null && (SBX_CORES as readonly string[]).includes(core);
}
