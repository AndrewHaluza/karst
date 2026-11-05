import type { Store } from '../../store/db.js';
import { acquireGateSlot, countGateSlots, GATE_SLOT_HEARTBEAT_MS, reapStaleGateSlots, releaseGateSlot, STALE_GATE_SLOT_MS, touchGateSlot } from '../../store/gateSlots.js';
import type { GateProcessRunner } from '../../workflow/gates/run.js';

/** How often a waiting gate retries for a slot. */
export const GATE_SLOT_POLL_MS = 2_000;

export interface GateSlotDeps {
  readonly store: Store;
  /** Slots per project (`sandboxLimits.gateSlots`, default 2). 0 = unlimited. Read per gate. */
  readonly limit: () => number;
  readonly projectIdOf: (ticketId: number) => number | null;
  /** The extension host that holds the slot (its pid). */
  readonly owner: string;
  readonly debug?: (message: string) => void;
  readonly pollMs?: number;
  readonly heartbeatMs?: number;
  readonly staleMs?: number;
}

/** The line a waiting gate prints into its live output. */
export const waitingForSlotNote = (running: number): string => `Waiting for a gate slot (${running} running)`;

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });

/**
 * Wrap a sandbox gate runner so it takes a project-wide slot first. The slot is held while the gate runs, refreshed by a
 * heartbeat, and released in `finally`: on a verdict, a throw and an abort alike. A gate that finds no slot waits (and
 * says so); an abort while waiting ends it as `aborted` without ever holding a slot. Agents never pass through here.
 */
export function withGateSlot(deps: GateSlotDeps, ticketId: number, run: GateProcessRunner): GateProcessRunner {
  return async (command, args, cwd, options) => {
    const limit = deps.limit();
    if (limit === 0) return run(command, args, cwd, options);
    const projectId = deps.projectIdOf(ticketId);
    const staleMs = deps.staleMs ?? STALE_GATE_SLOT_MS;
    let slot: number | null = null;
    let noted = false;
    for (;;) {
      if (options?.signal?.aborted) return { kind: 'aborted', output: '' };
      reapStaleGateSlots(deps.store, staleMs, projectId);
      slot = acquireGateSlot(deps.store, { ticketId, projectId, owner: deps.owner, limit });
      if (slot !== null) break;
      const note = waitingForSlotNote(countGateSlots(deps.store, projectId));
      if (!noted) {
        noted = true;
        deps.debug?.(`[gate] ticket ${ticketId}: ${note}`);
        options?.onOutput?.({ stream: 'stderr', text: `${note}\n` });
      }
      await sleep(deps.pollMs ?? GATE_SLOT_POLL_MS, options?.signal);
    }
    const held = slot;
    const beat = setInterval(() => {
      try { touchGateSlot(deps.store, held); } catch (err) { deps.debug?.(`[gate] slot heartbeat failed: ${err instanceof Error ? err.message : String(err)}`); }
    }, deps.heartbeatMs ?? GATE_SLOT_HEARTBEAT_MS);
    beat.unref?.();
    try {
      return await run(command, args, cwd, options);
    } finally {
      clearInterval(beat);
      releaseGateSlot(deps.store, held);
    }
  };
}
