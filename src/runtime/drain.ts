/**
 * The host's drain flag (@arch:DRAIN-01). While it is set, no new stage, gate,
 * host gate re-run or headless-agent run starts; runs already live finish. It
 * lives in memory only: a window reload clears it by design.
 */
export interface Drain {
  isDraining(): boolean;
  begin(): void;
  /** Clears the flag. Returns the tickets a start was refused for, so the host can re-drive them. */
  cancel(): number[];
  /** Records that a start for this ticket was refused while draining. */
  hold(ticketId: number): void;
  /** Runs `fn` and counts it as a live run until it settles. */
  track<T>(fn: () => Promise<T>): Promise<T>;
  /** The number of tracked runs that have not settled. */
  inFlight(): number;
}

export function createDrain(): Drain {
  let draining = false;
  let live = 0;
  const held = new Set<number>();
  return {
    isDraining: () => draining,
    begin: () => {
      draining = true;
    },
    cancel: () => {
      draining = false;
      const ids = [...held];
      held.clear();
      return ids;
    },
    hold: (ticketId) => {
      held.add(ticketId);
    },
    track: async (fn) => {
      live += 1;
      try {
        return await fn();
      } finally {
        live -= 1;
      }
    },
    inFlight: () => live,
  };
}
