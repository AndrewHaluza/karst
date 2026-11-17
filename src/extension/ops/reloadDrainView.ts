import type { LiveRun } from './reloadWhenIdle.js';

/**
 * What the dashboard may know about a reload that waits (@arch:DRAIN-01): the drain flag, the live runs it waits
 * for, and the tickets a start was refused for. One snapshot source for the progress text and the dashboard
 * banner, so both name the same runs. Host-agnostic: the handler binds the source while a reload waits.
 */
export interface DrainSnapshot {
  readonly draining: boolean;
  readonly live: readonly LiveRun[];
  readonly held: readonly number[];
}

export const IDLE_DRAIN: DrainSnapshot = { draining: false, live: [], held: [] };

let source: (() => DrainSnapshot) | null = null;
let canceller: (() => void) | null = null;
const listeners = new Set<() => void>();

/** The current drain snapshot; idle when no reload waits. */
export function drainSnapshot(): DrainSnapshot {
  return source ? source() : IDLE_DRAIN;
}

/** Tells every listener that the snapshot may have changed. A listener that throws does not stop the others. */
export function notifyDrainChange(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // A failing repaint must not stop the reload or the other listeners.
    }
  }
}

/** Subscribes to snapshot changes. Returns the unsubscribe function. */
export function onDrainChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** Binds the snapshot source and the cancel hook for one waiting reload. Returns the unbind function. */
export function bindReloadDrain(read: () => DrainSnapshot, cancel: () => void): () => void {
  source = read;
  canceller = cancel;
  notifyDrainChange();
  return () => {
    if (source === read) {
      source = null;
      canceller = null;
    }
    notifyDrainChange();
  };
}

/** Cancels the waiting reload, the same way the progress notification Cancel does. False when none waits. */
export function cancelReloadDrain(): boolean {
  if (!canceller) return false;
  canceller();
  return true;
}

/** A stable text of a snapshot, so the host pushes only a real change. */
export function drainSignature(s: DrainSnapshot): string {
  return JSON.stringify([s.draining, s.live.map((r) => [r.ticketId, r.kind]), s.held]);
}
