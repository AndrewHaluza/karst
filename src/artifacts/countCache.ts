/**
 * Per-ticket artifact count for the sidebar badge. The sidebar state builder is
 * synchronous but the count is a git read, so `get` answers from memory and
 * schedules a refresh when the entry is older than `ttlMs`; a changed count
 * calls `onChange` so the sidebar repaints. Host-agnostic.
 */

export interface ArtifactCountCacheOptions {
  count: (ticketId: number) => Promise<number>;
  /** A count changed after a background load. */
  onChange: () => void;
  onError?: (error: unknown) => void;
  now?: () => number;
  ttlMs?: number;
}

export interface ArtifactCountCache {
  /** The last known count (0 before the first load); may start a background refresh. */
  get(ticketId: number): number;
  /** Record a count the caller already has (the dashboard loader); never signals. */
  set(ticketId: number, count: number): void;
}

const DEFAULT_TTL_MS = 5_000;

export function createArtifactCountCache(opts: ArtifactCountCacheOptions): ArtifactCountCache {
  const now = opts.now ?? Date.now;
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
  const entries = new Map<number, { count: number; at: number }>();
  const inFlight = new Set<number>();

  const refresh = (ticketId: number): void => {
    if (inFlight.has(ticketId)) return;
    inFlight.add(ticketId);
    void opts.count(ticketId).then(
      (count) => {
        const before = entries.get(ticketId)?.count;
        entries.set(ticketId, { count, at: now() });
        inFlight.delete(ticketId);
        if (before !== count && !(before === undefined && count === 0)) opts.onChange();
      },
      (error: unknown) => {
        // Keep the last good count, and retry only after the freshness window.
        const prev = entries.get(ticketId);
        entries.set(ticketId, { count: prev?.count ?? 0, at: now() });
        inFlight.delete(ticketId);
        opts.onError?.(error);
      },
    );
  };

  return {
    get(ticketId) {
      const e = entries.get(ticketId);
      if (!e || now() - e.at >= ttl) refresh(ticketId);
      return e?.count ?? 0;
    },
    set(ticketId, count) {
      entries.set(ticketId, { count, at: now() });
    },
  };
}
