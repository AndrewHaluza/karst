import type { StageKey } from '../model/types.js';

/**
 * Which stage's done marker (§5.4) a session seed should carry.
 *
 * Only `impl` and `fix` have interactive agent work (see `shouldResumeSession`),
 * so those are the only two markers a seed can usefully fire. A session opened at
 * `fix` must be told `stage fix pass` — seeding the impl marker there was why a
 * fixed ticket never left `fix`. Everything else is a fresh impl launch.
 */
export function markerStageFor(stageCurrent: StageKey | null): StageKey {
  return stageCurrent === 'fix' ? 'fix' : 'impl';
}
