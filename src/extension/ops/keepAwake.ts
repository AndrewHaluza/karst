import type { Store } from '../../store/db.js';
import { listLiveRuns } from './reloadWhenIdle.js';

/**
 * The keep-awake lock (@arch:KEEPAWAKE): one `caffeinate` child per window while a
 * run of that window is live, so the Mac does not sleep through a gate, a ship or
 * an agent on AC power. Host-agnostic: the platform, clock and spawn arrive through
 * the injected seams, so the whole rule runs under vitest with a fake spawn.
 */

/** The `karst.keepAwake` values. */
export type KeepAwakeMode = 'auto' | 'off' | 'always';

/** How long an unchanged live set may hold the Mac awake; then the lock is released until it changes. */
export const KEEP_AWAKE_MAX_HOLD_MS = 4 * 60 * 60 * 1000;

/** How fresh `tickets.last_hook_at` must be for a `running` agent to count as live (a stuck run holds nothing). */
export const KEEP_AWAKE_AGENT_FRESH_MS = 60 * 60 * 1000;

/** How often the host re-reads the setting and the live set. */
export const KEEP_AWAKE_INTERVAL_MS = 30_000;

/** An unknown or absent setting reads as `auto`: the loss must not repeat for a user who never chose. */
export function keepAwakeMode(value: unknown): KeepAwakeMode {
  return value === 'off' || value === 'always' ? value : 'auto';
}

/**
 * The `caffeinate` argv for a mode: `auto` asserts system sleep off, which macOS
 * honours on AC power only (no power-source probe needed); `always` asserts idle
 * sleep off, which also holds on battery; `off` asserts nothing. `-w <pid>` ends
 * the child when the extension host dies, so no stale lock outlives it.
 */
export function caffeinateArgs(mode: string | undefined, hostPid: number): string[] | null {
  const resolved = keepAwakeMode(mode);
  if (resolved === 'off') return null;
  return [resolved === 'always' ? '-i' : '-s', '-w', String(hostPid)];
}

/** The slice of a spawned `caffeinate` the lock touches. */
export interface KeepAwakeChild {
  kill(): void;
  on(event: string, listener: (value: unknown) => void): unknown;
}

export type KeepAwakeSpawn = (
  command: string,
  args: readonly string[],
  options: { readonly stdio: 'ignore' },
) => KeepAwakeChild;

export interface KeepAwakeDeps {
  /** `process.platform`; anything but `darwin` makes the factory a no-op. */
  readonly platform: string;
  /** The extension host pid: `-w` ends the child with it. */
  readonly hostPid: number;
  /** The `karst.keepAwake` value, read fresh on every tick. */
  readonly mode: () => string | undefined;
  /** The live-run keys of this window (`keepAwakeLiveKeys`). */
  readonly liveKeys: () => readonly string[];
  readonly now: () => number;
  readonly spawn: KeepAwakeSpawn;
  /** One line per start and per release, plus one for a failed spawn and the hold limit. */
  readonly debug: (message: string) => void;
}

export interface KeepAwake {
  /** Re-read the setting and the live set, then start, restart or release the lock. */
  tick(): void;
  /** Kill the child; a disposed lock never starts another. */
  dispose(): void;
}

/**
 * The lock: at most one `caffeinate` child per window. A tick starts it when a run
 * is live (and the mode is not `off`), kills it when no run is live (or the mode
 * turns off), and restarts it when the mode changes. A failed spawn is tried once
 * per window. An unchanged live set releases the lock after
 * `KEEP_AWAKE_MAX_HOLD_MS`, so a stuck run cannot hold the Mac awake forever.
 *
 * One child per window is correct: each window holds the lock for its own runs.
 */
export function makeKeepAwake(deps: KeepAwakeDeps): KeepAwake {
  if (deps.platform !== 'darwin') return { tick: () => {}, dispose: () => {} };

  /** The one child this window runs, with the mode it was started for. */
  let running: { readonly child: KeepAwakeChild; readonly mode: KeepAwakeMode } | null = null;
  let spawnFailed = false;
  let disposed = false;
  /** The sorted live-key signature; `null` until the first tick. */
  let signature: string | null = null;
  let signatureSince = 0;
  let holdLimitReached = false;

  /** Kills the child if one runs; returns the mode it held, or null when none ran. */
  const killChild = (): KeepAwakeMode | null => {
    const current = running;
    running = null;
    if (current === null) return null;
    try {
      current.child.kill();
    } catch {
      // Already gone: nothing to kill, and the lock is released all the same.
    }
    return current.mode;
  };

  const release = (live: number): void => {
    const was = killChild();
    if (was !== null) deps.debug(`keep awake: release (mode ${was}, ${live} live)`);
  };

  const tick = (): void => {
    if (disposed) return;
    const mode = keepAwakeMode(deps.mode());
    const keys = [...new Set(deps.liveKeys())].sort();
    const now = deps.now();
    const next = keys.join('\n');
    if (next !== signature) {
      signature = next;
      signatureSince = now;
      holdLimitReached = false;
    } else if (!holdLimitReached && keys.length > 0 && now - signatureSince >= KEEP_AWAKE_MAX_HOLD_MS) {
      holdLimitReached = true;
      deps.debug(
        `keep awake: hold limit after ${KEEP_AWAKE_MAX_HOLD_MS} ms with an unchanged live set (mode ${mode}, ${keys.length} live) — releasing until it changes`,
      );
    }
    const want = keys.length > 0 && !holdLimitReached && !spawnFailed;
    // `null` means "do not hold": the mode is off (or nothing was wanted).
    const args = want ? caffeinateArgs(mode, deps.hostPid) : null;
    if (args === null) {
      release(keys.length);
      return;
    }
    if (running !== null) {
      if (running.mode === mode) return; // one child per window
      release(keys.length); // the mode changed: the argv must change with it
    }
    let child: KeepAwakeChild;
    try {
      child = deps.spawn('caffeinate', args, { stdio: 'ignore' });
    } catch (error) {
      spawnFailed = true;
      deps.debug(`keep awake: caffeinate failed to start (mode ${mode}): ${String(error)} — not retrying in this window`);
      return;
    }
    running = { child, mode };
    child.on('error', (error: unknown) => {
      spawnFailed = true;
      if (running?.child === child) running = null;
      deps.debug(`keep awake: caffeinate failed (mode ${mode}): ${String(error)} — not retrying in this window`);
    });
    child.on('exit', () => {
      // An unexpected exit: the next tick starts it again (unless the mode or the live set says no).
      if (running?.child === child) running = null;
    });
    deps.debug(`keep awake: start caffeinate ${args.join(' ')} (mode ${mode}, ${keys.length} live)`);
  };

  const dispose = (): void => {
    disposed = true;
    killChild();
  };

  return { tick, dispose };
}

/**
 * The live-run keys this window holds the lock for (@arch:KEEPAWAKE):
 * `kind:ticketId` for every entry `listLiveRuns` returns (gates, ships, delivers,
 * stage processes, headless agents and graph nodes, all of this host's pid), plus
 * `agent:ticketId` for each running agent of the project whose hook fired in the
 * last `KEEP_AWAKE_AGENT_FRESH_MS`. `listLiveRuns` leaves the interactive impl/fix
 * terminals out on purpose, and a stale `running` state must not hold the lock, so
 * the freshness test is required.
 */
export function keepAwakeLiveKeys(
  store: Store,
  hostPid: number,
  projectId: number | undefined,
  inFlight: number,
  trackedDeliverTickets: readonly number[],
  now: number,
): string[] {
  const keys = new Set<string>();
  for (const run of listLiveRuns(store, hostPid, inFlight, ...trackedDeliverTickets)) {
    keys.add(`${run.kind}:${run.ticketId ?? 'none'}`);
  }
  if (projectId !== undefined) {
    const rows = store.db
      .prepare(
        `SELECT id, last_hook_at FROM tickets
          WHERE project_id = ? AND archived_at IS NULL AND agent_state = 'running' AND last_hook_at IS NOT NULL`,
      )
      .all(projectId) as { id: number; last_hook_at: string }[];
    for (const row of rows) {
      const at = Date.parse(row.last_hook_at);
      if (now - at <= KEEP_AWAKE_AGENT_FRESH_MS) keys.add(`agent:${row.id}`);
    }
  }
  return [...keys].sort();
}
