import type { Store } from '../../store/db.js';
import type { Drain } from '../../runtime/drain.js';

/**
 * "Karst: Reload window when idle" (@arch:DRAIN-01). Set the drain flag so no new
 * stage, gate or headless-agent run starts, wait until no run of this host is
 * live, then reload. A cancel clears the flag. Host-agnostic: vscode arrives
 * through the injected seams.
 */
export const RELOAD_WHEN_IDLE_COMMAND = 'karst.reloadWhenIdle';
export const RELOAD_WHEN_IDLE_TITLE = 'Karst: Reload window when idle';
export const IDLE_POLL_MS = 2000;

/**
 * Live runs of THIS host: `process_runs` and `stage_runs` (every gate and the
 * ship run live inside a stage run) whose status is 'running' and whose pid is
 * the host's, and the `deliver_runs` rows with state 'running' (an auto-deliver
 * runs its gates outside any stage run). `extra` adds the host gate re-runs, which write no run row (`Drain.track`). A run of another window has another pid and is not counted.
 * Interactive impl/fix terminals are not counted: the pty host keeps them
 * across a reload (@arch:AC-15).
 */
export function countLiveRuns(store: Store, hostPid: number, extra = 0): number {
  const count = (table: 'process_runs' | 'stage_runs'): number => {
    const row = store.db
      .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE status = 'running' AND pid = ?`)
      .get(hostPid) as { n: number };
    return row.n;
  };
  const deliver = store.db
    .prepare("SELECT COUNT(*) AS n FROM deliver_runs WHERE state = 'running' AND pid = ?")
    .get(hostPid) as { n: number };
  return count('process_runs') + count('stage_runs') + deliver.n + extra;
}

export interface ReloadWhenIdleDeps {
  readonly drain: Drain;
  readonly countLive: () => number;
  readonly reload: () => Promise<void>;
  /** Called with each new count; the host shows it. */
  readonly onCount: (live: number) => void;
  readonly sleep: (ms: number) => Promise<void>;
  readonly signal: AbortSignal;
  readonly log: (message: string) => void;
  /** Called with the tickets a start was refused for, after a cancel. */
  readonly onCancelled?: (held: readonly number[]) => void;
  readonly pollMs?: number;
}

export type ReloadWhenIdleResult = 'reloaded' | 'cancelled';

export async function reloadWhenIdle(deps: ReloadWhenIdleDeps): Promise<ReloadWhenIdleResult> {
  deps.drain.begin();
  deps.log('reload when idle: draining — no new stage, gate or agent run starts');
  let last = -1;
  for (;;) {
    if (deps.signal.aborted) {
      const held = deps.drain.cancel();
      deps.log(`reload when idle: cancelled — new runs may start again (${held.length} held)`);
      deps.onCancelled?.(held);
      return 'cancelled';
    }
    const live = deps.countLive();
    if (live !== last) {
      last = live;
      deps.onCount(live);
    }
    if (live === 0) {
      deps.log('reload when idle: no live run — reloading the window');
      try {
        await deps.reload();
      } catch (err) {
        deps.onCancelled?.(deps.drain.cancel());
        throw err;
      }
      return 'reloaded';
    }
    await deps.sleep(deps.pollMs ?? IDLE_POLL_MS);
  }
}
