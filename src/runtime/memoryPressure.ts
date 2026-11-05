/** One running sandbox and its host footprint (the Resources sampler's reading). */
export interface SandboxFootprint {
  readonly name: string;
  readonly ticketId: number;
  readonly footprintBytes: number;
}

export const PRESSURE_DEBOUNCE_MS = 10 * 60_000;

export interface PressureWatchDeps {
  readonly freeBytes: () => Promise<number>;
  readonly minFreeBytes: () => number;
  readonly sandboxes: () => readonly SandboxFootprint[];
  /** Shows the warning with a Stop button; resolves true when the user chose Stop. */
  readonly warn: (message: string, biggest: SandboxFootprint) => Promise<boolean>;
  readonly stop: (biggest: SandboxFootprint) => Promise<void>;
  readonly now?: () => number;
  readonly debounceMs?: number;
}

const gb = (b: number): string => (b / 1024 ** 3).toFixed(1);

/** The sandbox with the largest footprint, or undefined with none running. */
export function largestSandbox(list: readonly SandboxFootprint[]): SandboxFootprint | undefined {
  return list.reduce<SandboxFootprint | undefined>((a, b) => (a === undefined || b.footprintBytes > a.footprintBytes ? b : a), undefined);
}

/**
 * While sandboxes run and free memory drops under the threshold, warn once (debounced) naming the largest one.
 * Returns whether a warning was shown this tick.
 */
export function makePressureWatch(deps: PressureWatchDeps): { tick(): Promise<boolean> } {
  let lastAt = Number.NEGATIVE_INFINITY;
  const now = deps.now ?? Date.now;
  return {
    tick: async () => {
      const running = deps.sandboxes();
      const biggest = largestSandbox(running);
      if (biggest === undefined) return false;
      const free = await deps.freeBytes();
      const need = deps.minFreeBytes();
      if (free >= need) return false;
      if (now() - lastAt < (deps.debounceMs ?? PRESSURE_DEBOUNCE_MS)) return false;
      lastAt = now();
      const message = `Host memory is low (free ${gb(free)} GB, needs ${gb(need)} GB). Sandbox ${biggest.name} uses the most (${gb(biggest.footprintBytes)} GB).`;
      if (await deps.warn(message, biggest)) await deps.stop(biggest);
      return true;
    },
  };
}
