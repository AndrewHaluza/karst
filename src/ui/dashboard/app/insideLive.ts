/**
 * The live half of the Inside block, as pure functions the store and the components share. The host re-sends the
 * whole snapshot every second while work runs, but what actually moves is small: the clock text, a running row's
 * elapsed time, and the token claim. `sameIgnoringLive` names exactly that set, so a component can keep its previous
 * slice across a push that only advanced a clock, while the small leaf components that DO show a clock or a token
 * read their own value.
 */
import type { InsideProgressEvent, LiveOperationView } from '../../../model/inside/progress.js';
import type { InsideProcessView, InsideStageView } from '../../../model/inside/types.js';
import type { LiveClocks } from '../liveTick.js';
import type { DashboardState } from '../state.js';

/** The transient overlays of one stage: the live header (`active`) and the row that replaces a snapshot's (`completed`). */
export interface StageOverlay {
  readonly active?: LiveOperationView;
  readonly processId?: string;
  readonly completed?: InsideProcessView;
}
export type LiveOps = Readonly<Record<string, StageOverlay>>;

/** Keys formatted against "now" (liveTick.ts `CLOCK_KEYS`), plus the token claim: the only things a live push moves. */
const LIVE_KEYS: ReadonlySet<string> = new Set(['clock', 'duration', 'durationExact', 'time', 'age', 'tokens']);

/** Structural equality that does not see the live keys, at any depth. */
export function sameIgnoringLive(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left).filter((k) => !LIVE_KEYS.has(k));
  const otherKeys = Object.keys(right).filter((k) => !LIVE_KEYS.has(k));
  if (keys.length !== otherKeys.length) return false;
  return keys.every((k) => Object.hasOwn(right, k) && sameIgnoringLive(left[k], right[k]));
}

/**
 * The rows to draw: a `completed` overlay replaces the snapshot's same-id row (or is appended). A live event is a
 * STATUS update, not a snapshot: it carries no evidence, so overwriting the row wholesale would delete evidence already
 * on screen. Every field the event does not speak to is kept; the next snapshot is authoritative and retires the overlay.
 */
export function overlayProcesses(view: InsideStageView, ops: LiveOps): InsideProcessView[] {
  const done = ops[view.stageKey]?.completed;
  if (!done) return view.processes;
  if (!view.processes.some((p) => p.id === done.id)) return view.processes.concat(done);
  return view.processes.map((p) => (p.id === done.id ? { ...p, ...done, evidence: done.evidence ?? p.evidence } : p));
}

/** The header IS the current operation: the progress event wins while one is in flight, else the snapshot's derived line. */
export function liveOperation(view: InsideStageView, ops: LiveOps): LiveOperationView | null {
  return ops[view.stageKey]?.active ?? view.live ?? null;
}

/** Folds one `inside-progress` event into the overlays. */
export function receiveProgress(ops: LiveOps, event: InsideProgressEvent): LiveOps {
  if (event.kind === 'active') return { ...ops, [event.stage]: { active: event.live, processId: event.processId } };
  if (event.kind === 'completed') return { ...ops, [event.stage]: { completed: event.process } };
  if (!(event.stage in ops)) return ops;
  const rest = { ...ops };
  delete rest[event.stage];
  return rest;
}

/**
 * A full snapshot supersedes the overlay. One that actually CONTAINS the process retires it: for `completed` any
 * presence (its row is the final one), for `active` only a terminal row, because an unrelated push mid-gate must not
 * drop the live header while the same row still reads `run`. Absence keeps the overlay: a snapshot that does not
 * know the process cannot answer about it.
 */
export function retireOverlays(ops: LiveOps, state: DashboardState): LiveOps {
  let next: Record<string, StageOverlay> | null = null;
  for (const [stage, entry] of Object.entries(ops)) {
    const id = entry.completed ? entry.completed.id : entry.processId;
    if (!id) continue;
    const row = (state.insideViews?.[stage as keyof DashboardState['insideViews']]?.processes ?? []).find((p) => p.id === id);
    if (row && (entry.completed || row.status !== 'run')) {
      next ??= { ...ops };
      delete next[stage];
    }
  }
  return next ?? ops;
}

/** A `clocks` repaint merged into the snapshot held: the same text a live `state` repaint would have carried. Returns a new snapshot. */
export function applyClocks(state: DashboardState, clocks: LiveClocks): DashboardState {
  const views: Record<string, InsideStageView> = { ...state.insideViews };
  for (const [key, c] of Object.entries(clocks)) {
    const view = views[key];
    if (!view || !c) continue;
    views[key] = {
      ...view,
      clock: c.clock,
      live: view.live && c.live !== undefined ? { ...view.live, duration: c.live } : view.live,
      processes: view.processes.map((p) => (c.processes[p.id] ? { ...p, ...c.processes[p.id] } : p)),
    };
  }
  return { ...state, insideViews: views as DashboardState['insideViews'] };
}
