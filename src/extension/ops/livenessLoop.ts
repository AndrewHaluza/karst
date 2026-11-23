import type { Store } from '../../store/db.js';
import {
  sweepServerLiveness,
  describeCrashed,
  type SweepLivenessOpts,
} from '../../runtime/livenessSweep.js';

/** How often an open dashboard or Resources panel re-probes server liveness. */
export const LIVENESS_SWEEP_MS = 15_000;

export interface LivenessLoopDeps {
  store: Store;
  /** How many dashboard panels are currently open. */
  openPanelCount: () => number;
  /** How many Resources panels are open (0 or 1). The loop idles when both counts are 0. */
  openResourcesCount?: () => number;
  /** Probe overrides for tests; production uses the real probes. */
  sweepOpts?: Omit<SweepLivenessOpts, 'debug' | 'ticketId'>;
  /** Repaint everything that renders server status. */
  refresh: () => void;
  info: (message: string) => void;
  debug: (message: string) => void;
  logError: (message: string, err: unknown) => void;
  /** Injected for tests; defaults to `setTimeout`/`clearTimeout`. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface SweepNowOptions {
  /** Sweep even when no panel is open (the monitor reading feeds the status bar). */
  always?: boolean;
}

export interface LivenessLoop {
  /**
   * Run one sweep now (focus, the timer, the Resources poll, the monitor
   * reading). Single-flight: a call during a sweep waits for that sweep. Never throws.
   */
  sweepNow(opts?: SweepNowOptions): Promise<void>;
  /** Begin the periodic loop. Idempotent. */
  start(): void;
  /** Stop the periodic loop. Idempotent. */
  dispose(): void;
}

/**
 * Drive the liveness sweep while a dashboard or the Resources panel is open.
 *
 * The dashboard renders each server row's `status` column verbatim, so a row
 * that claims `running` keeps claiming it until something re-derives the truth.
 * `runBootSweeps` does that once, at activation; a GCP VM suspend/resume that
 * kills the processes without restarting the extension host never runs it. This
 * loop re-probes every 15 s while at least one panel is open, and on every
 * window-focus event, then repaints. The Resources poll (5 s) and the monitor
 * reading call `sweepNow` too; the single flight keeps the calls from racing.
 * It never throws: a failed sweep must not take the extension host down, and
 * it must not stop the loop.
 */
export function createLivenessLoop(deps: LivenessLoopDeps): LivenessLoop {
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const openResourcesCount = deps.openResourcesCount ?? (() => 0);
  let inFlight: Promise<void> | undefined;
  let stopped = false;
  let started = false;
  let timer: unknown;

  const runSweep = async (opts: SweepNowOptions): Promise<void> => {
    try {
      // Inside the try: a throwing UI query must be reported, not reject the
      // promise. A rejection would skip the timer's `.then` re-arm and stop the
      // periodic loop for good.
      if (opts.always !== true && deps.openPanelCount() + openResourcesCount() === 0) return;
      const crashed = await sweepServerLiveness(deps.store, { ...deps.sweepOpts, debug: deps.debug });
      if (crashed.length === 0) return;
      for (const s of crashed) deps.info(describeCrashed(s));
      deps.refresh();
    } catch (err) {
      deps.logError('karst: server liveness sweep failed', err);
    }
  };

  const sweepNow = (opts: SweepNowOptions = {}): Promise<void> => {
    if (inFlight !== undefined) return inFlight;
    const run = runSweep(opts).finally(() => {
      inFlight = undefined;
    });
    inFlight = run;
    return run;
  };

  const arm = (): void => {
    timer = setTimer(() => {
      timer = undefined;
      if (stopped) return;
      void sweepNow().then(() => {
        if (!stopped) arm();
      });
    }, LIVENESS_SWEEP_MS);
    // Never hold the host's event loop open for a repaint timer.
    (timer as { unref?: () => void }).unref?.();
  };

  return {
    sweepNow,
    start(): void {
      // `started`, not `timer`: the callback clears `timer` while a sweep is in
      // flight, so a re-entrant `start()` would otherwise arm a second timer.
      if (stopped || started) return;
      started = true;
      arm();
    },
    dispose(): void {
      stopped = true;
      if (timer !== undefined) {
        clearTimer(timer);
        timer = undefined;
      }
    },
  };
}
