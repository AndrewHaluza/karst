import type { Store } from './db.js';

/**
 * Watch for commits made by OTHER connections to the same database file.
 *
 * `PRAGMA data_version` changes when a different connection commits, and never
 * for a write on this one — so this fires for the `karst` CLI (a separate
 * `node` process the agent invokes) and stays silent for the extension host's
 * own writes, which already push their own state.
 */
export function watchExternalChanges(
  store: Store,
  onChange: () => void,
  opts: {
    intervalMs?: number;
    setInterval?: (cb: () => void, ms: number) => unknown;
    clearInterval?: (timer: unknown) => void;
  } = {},
): { dispose(): void } {
  const intervalMs = opts.intervalMs ?? 2000;
  const schedule = opts.setInterval ?? setInterval;
  const cancel = (opts.clearInterval ?? clearInterval) as (timer: unknown) => void;
  let last: number | null = null;
  let disposed = false;
  let timer: unknown;

  const poll = (): void => {
    if (disposed) return;
    let current: number | null = null;
    try {
      // The pragma comes back as a row object — read the column off it, never
      // assume a scalar.
      const row = store.db.prepare('PRAGMA data_version').get() as
        | { data_version?: unknown }
        | undefined;
      const value = row?.data_version;
      current = typeof value === 'number' ? value : null;
    } catch {
      // A locked database must never take down the host: keep the last value
      // and try again on the next tick.
      return;
    }
    if (current === null) return; // could not read — never fire on a guess
    if (last !== null && current !== last) onChange();
    last = current;
  };

  timer = schedule(poll, intervalMs);
  return {
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (timer !== undefined) cancel(timer);
      timer = undefined;
    },
  };
}
