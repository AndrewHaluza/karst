import type { Store } from '../store/db.js';
import type { Inventory } from '../runtime/resourceInventory.js';
import { makeMemoryQueue, type MemoryQueue } from './ops/memoryQueueOps.js';
import { makePressureWatch, type SandboxFootprint } from '../runtime/memoryPressure.js';
import type { Notify } from './ops/notify.js';
import type { Manifest } from '../manifest/types.js';
import { readFreeHostMemory } from '../agent/sbx/hostMemory.js';
import { totalmem } from 'node:os';
import { resolveMinFreeBytes, resolveSbxMemory } from '../agent/sbx/sbxMemory.js';
import { NODE_SBX_PROCESS } from '../agent/sbx/sbxProcess.js';

export interface MemoryBindingDeps {
  readonly store: Store;
  readonly notify: Notify;
  /** The current manifest: `sandboxMemory.sbxMinFree` is the admission threshold, read per sweep. */
  readonly manifest: () => Manifest | undefined;
  /** Free host memory (tests); default `vm_stat` / `os.freemem`. */
  readonly freeBytes?: () => Promise<number>;
  /** Relaunches the ticket through the normal open-session path (the same one an interactive launch takes). */
  readonly openSession: (ticketId: number) => Promise<unknown>;
  readonly label: (ticketId: number) => string;
  /** Repaints the sidebar and the dashboard for a ticket whose waiting state changed. */
  readonly refresh: (ticketId: number) => void;
  readonly inventory: () => Inventory | null | undefined;
  readonly ownedSessions: () => Iterable<number>;
  readonly stopSandbox: (ticketId: number) => Promise<void>;
  readonly debug: (line: string) => void;
  readonly sweepMs: number;
  readonly pressureMs?: number;
}

export interface MemoryBinding {
  /** Gate a sandbox launch: true → go ahead; false → the ticket is queued ('Waiting for memory'), with Start anyway / Cancel offered. */
  admitLaunch(ticketId: number): Promise<boolean>;
  dispose(): void;
}

/** Wires the host-memory queue sweep and the pressure warning to the extension (arch:AUTOSTART pattern, arch:AC-37). */
export function bindMemory(d: MemoryBindingDeps): MemoryBinding {
  const freeBytes = d.freeBytes ?? ((): Promise<number> => readFreeHostMemory(NODE_SBX_PROCESS));
  const minFreeBytes = (): number => resolveMinFreeBytes(d.manifest()?.sandboxMemory?.sbxMinFree);
  /** Tickets the sweep (or Start anyway) just admitted: their relaunch skips the check once. */
  const admitted = new Set<number>();
  const queue: MemoryQueue = makeMemoryQueue({
    store: d.store, freeBytes, minFreeBytes, notify: d.notify, label: d.label, debug: d.debug,
    start: async (id) => {
      admitted.add(id);
      try {
        await d.openSession(id);
        return { ok: true };
      } finally {
        admitted.delete(id);
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
      const ids = [...d.ownedSessions()];
      const vm = inv.vmOverhead;
      return vm && ids.length > 0 ? ids.map((id) => ({ name: d.label(id), ticketId: id, footprintBytes: vm.rssBytes / ids.length })) : [];
    },
    warn: async (message) => (await d.notify.infoActions?.(message, ['Stop'])) === 'Stop',
    stop: (b) => d.stopSandbox(b.ticketId),
  });
  const pressureTimer = setInterval(() => void pressure.tick().catch(() => undefined), d.pressureMs ?? 30_000);
  return {
    admitLaunch: async (ticketId) => {
      if (admitted.delete(ticketId)) return true;
      const admission = await queue.admit(ticketId);
      if (admission.admitted) return true;
      d.refresh(ticketId);
      void d.notify.infoActions?.(`Karst: ${d.label(ticketId)}: ${admission.note}`, ['Start anyway', 'Cancel']).then(async (choice) => {
        if (choice === 'Cancel') queue.cancel(ticketId);
        else if (choice === 'Start anyway') await queue.startAnyway(ticketId);
        d.refresh(ticketId);
      });
      return false;
    },
    dispose: () => { clearInterval(sweepTimer); clearInterval(pressureTimer); },
  };
}

/** `sbx run --memory` for this host: manifest override or the 40% default (sbxMemory.ts). */
export function hostSbxMemory(override?: string): string {
  return resolveSbxMemory(totalmem(), override);
}
