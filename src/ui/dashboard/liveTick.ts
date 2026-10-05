import type { InsideStageKey, InsideStageView } from '../../model/inside/types.js';
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
 * moving" can never disagree.
 *
 * RUNNING only, on both carriers — a stage's live line reading `run`, or a
 * process row reading `run`. The other two live statuses are deliberately not
 * live work: `wait` is a park, which is waiting on a HUMAN and would be a timer
 * that never stops, and `fail` is settled.
 */
export function hasLiveWork(state: DashboardState): boolean {
  return Object.values(state.insideViews).some(
    (view) => view.live?.status === 'run' || view.processes.some((p) => p.status === 'run'),
  );
}

/**
 * Keys whose values are formatted against "now": they advance every second on
 * their own, so they must not read as structural change. Matched by NAME at any
 * depth — a time-derived field this set misses only makes a tick fall back to
 * the full snapshot it always used to send, never hides a real change.
 */
const CLOCK_KEYS: ReadonlySet<string> = new Set(['clock', 'duration', 'durationExact', 'time', 'age']);

/**
 * The snapshot with every clock removed, as a comparable string. Two ticks with
 * the same key differ only in what `liveClocks` carries, so the repaint can be
 * that and nothing else.
 */
export function structureKey(state: DashboardState): string {
  return JSON.stringify(state, (key, value: unknown) => (CLOCK_KEYS.has(key) ? undefined : value));
}

/** One running process row's clock text. */
export interface ProcessClocks {
  time?: string;
  duration?: string;
  durationExact?: string;
}

/** One stage's clock text: the header clock, the live op, its running rows. */
export interface StageClocks {
  clock: string;
  live?: string;
  processes: Record<string, ProcessClocks>;
}

export type LiveClocks = Partial<Record<InsideStageKey, StageClocks>>;

/**
 * Exactly the text the webview's live repaint writes (`updateInsideLive`), per
 * stage — the whole payload of a tick whose `structureKey` did not move.
 */
export function liveClocks(state: DashboardState): LiveClocks {
  const out: LiveClocks = {};
  for (const [key, view] of Object.entries(state.insideViews) as Array<[InsideStageKey, InsideStageView]>) {
    const processes: Record<string, ProcessClocks> = {};
    for (const p of view.processes) {
      if (p.status !== 'run') continue;
      processes[p.id] = { time: p.time, duration: p.duration, durationExact: p.durationExact };
    }
    out[key] = {
      clock: view.clock,
      ...(view.live?.duration !== undefined ? { live: view.live.duration } : {}),
      processes,
    };
  }
  return out;
}
