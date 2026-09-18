import type { StageRun } from '../../store/stageRuns.js';
import type { StageKey } from '../types.js';
import { attemptKey, type AttemptKey } from './rounds.js';

/**
 * Which invocation a gate stage is on RIGHT NOW — the fact no evidence table
 * can answer.
 *
 * `gate_runs`, `process_runs` and the findings tables all record that work
 * FINISHED, so a stage the fix cycle has just re-entered still reduces to its
 * PREVIOUS round's rows: the newest `runAt`, the greatest process-run id, the
 * findings that run owns. Rendering that as the live ledger is what showed a
 * fixed round's red gates and blocking findings under round 2.
 *
 * `stage_runs` (v25) is the one table written at ENTRY (`openStageRun`, before
 * the first gate starts), so it is the only thing that can say an invocation
 * exists before it has produced anything.
 *
 * Three answers, and the difference between the last two is the whole point:
 *
 *  - `undefined` — the stage has NO `stage_runs` row (a pre-v25 ticket, or a
 *    stage that never ran). Callers must fall back to the latest-by-`runAt`
 *    reduction, byte-for-byte: a legacy ticket's rows carry no stage run id and
 *    narrowing to one would empty its ledger.
 *  - `null` — a run exists, but the stage row was re-entered AFTER it started.
 *    The current invocation has opened nothing yet, so the live ledger is
 *    EMPTY. Absence, never a predecessor's verdict.
 *  - an `AttemptKey` — the rows of that stage run are the live picture.
 *
 * The newest run is chosen by `id`, never by array position: `listStageRuns`
 * orders by id today, but no query contract obliges it to, and this module
 * refuses to trust ordering anywhere (the same rule `rounds.ts` documents).
 *
 * The key itself is built from `id` alone, too: `attemptKey`'s `runAt`
 * argument only matters for its `ra:`-fallback branch (a pre-v25 row with no
 * stage run id), and `current.id` below is always a non-null `number`, so the
 * call always takes the `sr:` branch and the `runAt` it is given is dead. It
 * is passed anyway because it is the shared helper's signature, not because
 * this call reads it.
 */
export type CurrentAttempt = AttemptKey | null | undefined;

export function currentAttemptFor(
  stageRuns: readonly StageRun[],
  stageKey: StageKey,
  /** The stage row's current entry stamp — `StepperCell.startedAt`. */
  enteredAt: string | undefined,
): CurrentAttempt {
  let current: StageRun | undefined;
  for (const run of stageRuns) {
    if (run.stageKey !== stageKey) continue;
    if (current === undefined || run.id > current.id) current = run;
  }
  if (current === undefined) return undefined;
  // A stage entered after its newest run STARTED is on an invocation that has
  // not opened yet. `<` and not `<=`: `openStageRun` and `entryPatch` can land
  // on the same instant, and a run opened for THIS entry is this entry's run.
  if (enteredAt !== undefined && current.startedAt < enteredAt) return null;
  return attemptKey(current.id, current.runAt);
}
