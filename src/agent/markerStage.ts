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
 * Which stage's done marker a session seed should carry, or null when the
 * ticket's current stage has no marker to fire at all.
 *
 * A session opened at `fix` must be told `stage fix pass` — seeding the impl
 * marker there was why a fixed ticket never left `fix`. A session at `impl`
 * gets the impl marker. ANYWHERE else — `uat`, `review`, `ship`, `scope`,
 * `done` — the marker does not exist: the seeded marker would name an earlier
 * stage and the CLI would refuse it (the stage-advance guard), so an agent
 * that trusted it would report the ticket advanced when it had not moved.
 * Null there, and the seed omits the marker instruction entirely rather than
 * seeding a command that cannot succeed.
 */
export function markerStageFor(stageCurrent: StageKey | null): MarkerStage | null {
  if (stageCurrent === 'fix') return 'fix';
  if (stageCurrent === 'impl') return 'impl';
  return null;
}

/** Narrow an arbitrary argv string to a markable stage. */
export function isMarkerStage(v: string): v is MarkerStage {
  return (MARKER_STAGES as readonly string[]).includes(v);
}
