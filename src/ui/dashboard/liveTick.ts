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

const DIFF_DEPTH = 3;
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const stripClocks = (v: unknown): string =>
  JSON.stringify(v, (key, value: unknown) => (CLOCK_KEYS.has(key) ? undefined : value)) ?? '';

/**
 * Dotted paths (at most `DIFF_DEPTH` deep) where two snapshots differ, clocks
 * ignored — debug only, to name what made a push ship in full.
 */
export function changedPaths(prev: unknown, next: unknown, prefix = '', depth = 1): string[] {
  if (stripClocks(prev) === stripClocks(next)) return [];
  if (!isRecord(prev) || !isRecord(next) || depth > DIFF_DEPTH) return [prefix];
  const keys = [...new Set([...Object.keys(prev), ...Object.keys(next)])].filter((k) => !CLOCK_KEYS.has(k));
  return keys.flatMap((k) => changedPaths(prev[k], next[k], prefix ? `${prefix}.${k}` : k, depth + 1));
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

export const LIVE_HEARTBEAT_MS = 60_000;

/**
 * Stage and running-process keys that describe what work is actively moving.
 * Live logs dedupe on this set changing.
 */
export function liveSections(state: DashboardState): string[] {
  const sections: string[] = [];
  for (const [key, view] of Object.entries(state.insideViews ?? {})) {
    const active = view.processes?.filter((p) => p.status === 'run').map((p) => p.id) ?? [];
    if (view.live?.status === 'run' || active.length > 0) {
      sections.push(`${key}${active.length > 0 ? `:[${active.sort().join(',')}]` : ''}`);
    }
  }
  return sections.sort();
}

export interface LiveLogState {
  lastAt: number;
  lastReason: string;
  lastSections: string;
}

/**
 * Dedupe decision for `[dashboard]` live tick log lines:
 * log on first tick, when reason/sections change, or once per minute as heartbeat.
 */
export function shouldLogLiveTick(
  prev: LiveLogState | undefined,
  now: number,
  reason: string,
  sections: readonly string[],
  heartbeatMs = LIVE_HEARTBEAT_MS,
): { shouldLog: boolean; next: LiveLogState } {
  const sectionsKey = sections.join(';');
  if (!prev) {
    return { shouldLog: true, next: { lastAt: now, lastReason: reason, lastSections: sectionsKey } };
  }
  if (reason !== prev.lastReason || sectionsKey !== prev.lastSections) {
    return { shouldLog: true, next: { lastAt: now, lastReason: reason, lastSections: sectionsKey } };
  }
  if (now - prev.lastAt >= heartbeatMs) {
    return { shouldLog: true, next: { lastAt: now, lastReason: reason, lastSections: sectionsKey } };
  }
  return { shouldLog: false, next: prev };
}
