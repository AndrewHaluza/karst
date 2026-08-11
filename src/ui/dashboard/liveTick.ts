import type { DashboardState } from './state.js';

/**
 * How often an open dashboard re-pushes its snapshot while something inside it
 * is actually running.
 *
 * The inside block is process-led, but its processes are STORE rows
 * (`process_runs`, `gate_runs`, `stages`) that nothing pushes when they OPEN:
 * the host pushed a snapshot when a stage moved and when a gate completed, so a
 * tester run, a findings lane, a pr-description call — and the elapsed time of
 * every running row — sat frozen for the whole minutes they took. The live
 * `inside-progress` overlay covers only the one operation the driver narrates;
 * it is not a substitute for the snapshot the rest of the block reads.
 *
 * One second is the coarsest interval at which a rendered duration still reads
 * as a clock rather than a stutter, and a push is one synchronous store read of
 * a single ticket — the same read a stage transition already performs.
 */
export const LIVE_TICK_MS = 1000;

/**
 * Whether a snapshot describes work IN FLIGHT, i.e. whether re-reading the
 * store a second from now could say something different.
 *
 * Read off the built view rather than the store a second time: the view is what
 * the panel is showing, so "is anything moving" and "is anything drawn as
 * moving" can never disagree. A stage's `live` line (running or waiting) and a
 * process row that is running both qualify; a blocked/parked ticket does not —
 * it is waiting on a human, and polling it would be a timer that never stops.
 */
export function hasLiveWork(state: DashboardState): boolean {
  return Object.values(state.insideViews).some(
    (view) => view.live?.status === 'run' || view.processes.some((p) => p.status === 'run'),
  );
}
