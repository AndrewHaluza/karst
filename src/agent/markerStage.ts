import type { StageKey } from '../model/types.js';

/**
 * The only stages an agent may fire a done marker for (§5.4) — the two
 * boundaries with interactive agent work (see `shouldResumeSession`).
 *
 * This is the authority for that narrowing, on BOTH sides: `markerStageFor`
 * produces from it (the seed side) and `parseStageArgs` validates against it (the
 * CLI side). Keeping one list is what stops the marker CLI from drifting back
 * into accepting a gate key — see the note on `MarkerStage` below.
 */
export const MARKER_STAGES = ['impl', 'fix'] as const;

/**
 * A stage an agent is allowed to self-report. Deliberately narrower than
 * `StageKey`: a gate's verdict must come from an exit code, never from the agent
 * saying so, so `uat`/`review`/`ship` are not markable. Typing the seed side with
 * this makes a bad marker a compile error in the extension rather than a runtime
 * throw in the agent's shell.
 */
export type MarkerStage = (typeof MARKER_STAGES)[number];

/**
 * Which stage's done marker a session seed should carry.
 *
 * A session opened at `fix` must be told `stage fix pass` — seeding the impl
 * marker there was why a fixed ticket never left `fix`. Everything else is a
 * fresh impl launch.
 */
export function markerStageFor(stageCurrent: StageKey | null): MarkerStage {
  return stageCurrent === 'fix' ? 'fix' : 'impl';
}

/** Narrow an arbitrary argv string to a markable stage. */
export function isMarkerStage(v: string): v is MarkerStage {
  return (MARKER_STAGES as readonly string[]).includes(v);
}
