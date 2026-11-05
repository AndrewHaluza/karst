import type { Store } from '../../store/db.js';
import { claimMemoryWait, clearMemoryWait, listMemoryQueue, queueMemoryWait, requeueStaleMemoryClaims, STALE_MEMORY_CLAIM_MS } from '../../store/memoryQueue.js';
import { waitingNote } from '../../agent/sbx/sbxMemory.js';
import type { Notify } from './notify.js';

/**
 * Host-memory admission and queue (arch:AUTOSTART pattern). A sandbox start first reads REAL free host memory; below the
 * threshold the ticket is queued (never refused) and a sweep starts the oldest waiter once memory is free again, one
 * start per sweep, re-reading free memory before each claim.
 */
export type StartResult = { ok: true } | { ok: false; message: string };

export interface MemoryQueueDeps {
  readonly store: Store;
  /** Free host memory in bytes, read fresh on every call. */
  readonly freeBytes: () => Promise<number>;
  /** The threshold in bytes, read per call so a Settings save applies on the next sweep. */
  readonly minFreeBytes: () => number;
  /** Starts (or reattaches) the ticket's sandbox session; the same path an interactive launch takes. */
  readonly start: (ticketId: number) => Promise<StartResult>;
  readonly label: (ticketId: number) => string;
  readonly notify: Notify;
  readonly debug?: (line: string) => void;
}

export type Admission = { admitted: true } | { admitted: false; note: string };

export interface MemoryQueue {
  /** Gate a launch: admitted → start now; otherwise the ticket is queued with its 'Waiting for memory' note. */
  admit(ticketId: number): Promise<Admission>;
  /** One sweep: re-queue orphans, then start at most the oldest waiter. Returns the started ticket id, or null. */
  sweep(): Promise<number | null>;
  /** 'Start anyway': skip the check for this ticket and start it now. */
  startAnyway(ticketId: number): Promise<StartResult>;
  /** 'Cancel': leave the queue without starting. */
  cancel(ticketId: number): void;
}

export function makeMemoryQueue(deps: MemoryQueueDeps): MemoryQueue {
  const { store } = deps;
  const run = async (ticketId: number): Promise<StartResult> => {
    try {
      return await deps.start(ticketId);
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  };
  return {
    admit: async (ticketId) => {
      const free = await deps.freeBytes();
      const need = deps.minFreeBytes();
      if (free >= need) return { admitted: true };
      const note = waitingNote(free, need);
      queueMemoryWait(store, ticketId, note);
      return { admitted: false, note };
    },
    sweep: async () => {
      requeueStaleMemoryClaims(store, STALE_MEMORY_CLAIM_MS);
      const [first] = listMemoryQueue(store);
      if (first === undefined) return null;
      const free = await deps.freeBytes();
      const need = deps.minFreeBytes();
      if (free < need) {
        queueMemoryWait(store, first, waitingNote(free, need)); // keeps its place, refreshes the numbers
        return null;
      }
      if (!claimMemoryWait(store, first)) {
        deps.debug?.(`[memory-queue] ${deps.label(first)} was claimed elsewhere`);
        return null;
      }
      const result = await run(first);
      clearMemoryWait(store, first);
      if (!result.ok) deps.notify.warn(`Karst: ${deps.label(first)} could not start after waiting for memory: ${result.message.slice(0, 300)}`);
      return result.ok ? first : null;
    },
    startAnyway: async (ticketId) => {
      clearMemoryWait(store, ticketId);
      return run(ticketId);
    },
    cancel: (ticketId) => clearMemoryWait(store, ticketId),
  };
}
