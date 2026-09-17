import type { Store } from '../../store/db.js';
import { sweepServerLiveness, describeRetired } from '../../runtime/livenessSweep.js';

/** How often an open dashboard re-probes server liveness. */
export const LIVENESS_SWEEP_MS = 15_000;

export interface LivenessLoopDeps {
  store: Store;
  /** How many dashboard panels are currently open. The loop idles at 0. */
  openPanelCount: () => number;
  /** Repaint everything that renders server status. */
  refresh: () => void;
  info: (message: string) => void;
  debug: (message: string) => void;
  logError: (message: string, err: unknown) => void;
  /** Injected for tests; defaults to `setTimeout`/`clearTimeout`. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface LivenessLoop {
  /** Run one sweep now (focus, or the timer). Never throws. */
  sweepNow(): Promise<void>;
  /** Begin the periodic loop. Idempotent. */
  start(): void;
  /** Stop the periodic loop. Idempotent. */
  dispose(): void;
}

/**
 * Drive the liveness sweep while the dashboard is open.
 *
 * The dashboard renders each server row's `status` column verbatim, so a row
 * that claims `running` keeps claiming it until something re-derives the truth.
 * `runBootSweeps` does that once, at activation; a GCP VM suspend/resume that
 * kills the processes without restarting the extension host never runs it. This
 * loop re-probes every 15 s while at least one panel is open, and on every
 * window-focus event, then repaints. It never throws: a failed sweep must not
 * take the extension host down, and it must not stop the loop.
 */
export function createLivenessLoop(deps: LivenessLoopDeps): LivenessLoop {
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let inFlight = false;
  let stopped = false;
  let started = false;
  let timer: unknown;

  const sweepNow = async (): Promise<void> => {
    if (inFlight) return;
    inFlight = true;
    try {
      // Inside the try: a throwing UI query must be reported, not reject the
      // promise. A rejection would skip the timer's `.then` re-arm and stop the
      // periodic loop for good.
      if (deps.openPanelCount() === 0) return;
      const retired = await sweepServerLiveness(deps.store, { debug: deps.debug });
      if (retired.length === 0) return;
      for (const s of retired) deps.info(describeRetired(s));
      deps.refresh();
    } catch (err) {
      deps.logError('karst: server liveness sweep failed', err);
    } finally {
      inFlight = false;
    }
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
