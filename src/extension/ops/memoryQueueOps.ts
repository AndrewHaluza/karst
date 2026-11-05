import type { Store } from '../../store/db.js';
import { claimMemoryWait, clearMemoryWait, isMemoryWaiting, listMemoryQueue, queueMemoryWait, requeueStaleMemoryClaims, STALE_MEMORY_CLAIM_MS } from '../../store/memoryQueue.js';
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
  /** This window's project: the sweep only starts its tickets. Omitted → unscoped (tests). A function returning undefined → no project yet, no start. */
  readonly projectId?: () => number | undefined;
  /** True when the ticket already has a live session (a launch that bypassed the queue): its row is dropped, not started again. */
  readonly hasSession?: (ticketId: number) => boolean;
  /** After a start, wait this long before the next claim so the new VM's memory shows in the free reading. */
  readonly settleMs?: number;
  /** False when another window queued this ticket with launch options this window does not hold: leave it to that window. */
  readonly canStart?: (ticketId: number) => boolean;
  /** Identifies this window on rows it queues (the extension host pid). */
  readonly owner?: string;
  readonly now?: () => number;
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
  const now = deps.now ?? Date.now;
  let lastStartAt = -Infinity;
  let sweeping = false;
  const run = async (ticketId: number): Promise<StartResult> => {
    try {
      return await deps.start(ticketId);
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  };
  const sweepOnce = async (): Promise<number | null> => {
    const project = deps.projectId ? deps.projectId() : undefined;
    if (deps.projectId && project === undefined) return null;
    requeueStaleMemoryClaims(store, STALE_MEMORY_CLAIM_MS, project);
    if (now() - lastStartAt < (deps.settleMs ?? 0)) return null;
    const [first] = listMemoryQueue(store, project);
    if (first === undefined) return null;
    if (deps.hasSession?.(first)) {
      clearMemoryWait(store, first);
      deps.debug?.(`[memory-queue] ${deps.label(first)} already has a session: dropped from the queue`);
      return null;
    }
    if (deps.canStart && !deps.canStart(first)) return null;
    const free = await deps.freeBytes();
    const need = deps.minFreeBytes();
    if (free < need) {
      queueMemoryWait(store, first, waitingNote(free, need), deps.owner); // keeps its place, refreshes the numbers
      return null;
    }
    if (!claimMemoryWait(store, first)) {
      deps.debug?.(`[memory-queue] ${deps.label(first)} was claimed elsewhere`);
      return null;
    }
    const result = await run(first);
    clearMemoryWait(store, first);
    if (result.ok) lastStartAt = now();
    else deps.notify.warn(`Karst: ${deps.label(first)} could not start after waiting for memory: ${result.message.slice(0, 300)}`);
    return result.ok ? first : null;
  };
  return {
    admit: async (ticketId) => {
      const free = await deps.freeBytes();
      const need = deps.minFreeBytes();
      if (free >= need) {
        clearMemoryWait(store, ticketId); // a stale row must not start this ticket a second time
        return { admitted: true };
      }
      const note = waitingNote(free, need);
      queueMemoryWait(store, ticketId, note, deps.owner);
      return { admitted: false, note };
    },
    sweep: async () => {
      if (sweeping) return null;
      sweeping = true;
      try {
        return await sweepOnce();
      } finally {
        sweeping = false;
      }
    },
    startAnyway: async (ticketId) => {
      if (!isMemoryWaiting(store, ticketId)) return { ok: true }; // a late click: the ticket already started or was cancelled
      clearMemoryWait(store, ticketId);
      return run(ticketId);
    },
    cancel: (ticketId) => clearMemoryWait(store, ticketId),
  };
}
