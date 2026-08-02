import { MAIN_LINE, GATE_STAGES } from '../workflow/graph.js';
import { FIX_ATTEMPT_CAP } from '../workflow/fixAttempts.js';
import type { StepperCell } from './stepper.js';
import type { StageKey } from './types.js';

/**
 * Where the loop's parts attach, as column indices into `main`. The webview
 * turns these into CSS `calc()` inputs, so the bracket and the branch stem stay
 * bolted to the right columns instead of to hardcoded percentages: add a stage
 * and the loop moves with it rather than silently detaching.
 */
export interface RailGeometry {
  cols: number;
  impl: number;
  uat: number;
  review: number;
}

/**
 * The stage graph as it is drawn: a forward path plus the return channel that
 * hangs below it.
 *
 * `branch` is a separate field, not a flagged cell inside `main`, on purpose. A
 * marker would leave `fix` in the array and make every present and future
 * consumer responsible for filtering it — which is precisely how it ended up
 * rendered as a linear step in the first place. Splitting it out makes drawing
 * it inline structurally impossible.
 */
export interface StageRail {
  /** The forward path, in MAIN_LINE order. */
  main: StepperCell[];
  /** The fix return channel — entered only when a gate fails. */
  branch: StepperCell;
  geometry: RailGeometry;
  /** The loop is live: fix is running, or a gate is sitting failed. */
  armed: boolean;
  /** `attempt 2 of 3` once the loop has been entered; null while it is idle. */
  cap: string | null;
}

const BRANCH: StageKey = 'fix';

/** A cell for a stage that has no row yet — the pre-run default. */
function pending(stageKey: StageKey): StepperCell {
  return { stageKey, status: 'pending' };
}

function cellFor(stepper: readonly StepperCell[], stageKey: StageKey): StepperCell {
  return stepper.find((c) => c.stageKey === stageKey) ?? pending(stageKey);
}

/**
 * Split a flat stepper into the shape the rail is actually drawn in.
 *
 * `buildStepper` keeps its canonical 7-cell projection — that is correct, and
 * the ticket form relies on it. This is the dashboard's view on top of it.
 */
export function buildStageRail(
  stepper: readonly StepperCell[],
  fixAttempts: number,
): StageRail {
  const branch = cellFor(stepper, BRANCH);

  // Armed means the loop is in play: either fix is running, or a gate has failed
  // and the ticket is on its way there. A failure anywhere else (ship) is a dead
  // end the user retries, not a trip round this loop.
  const gateFailed = GATE_STAGES.some((k) => cellFor(stepper, k).status === 'failed');
  const armed = branch.status === 'running' || gateFailed;

  return {
    main: MAIN_LINE.map((k) => cellFor(stepper, k)),
    branch,
    geometry: {
      cols: MAIN_LINE.length,
      impl: MAIN_LINE.indexOf('impl'),
      uat: MAIN_LINE.indexOf('uat'),
      review: MAIN_LINE.indexOf('review'),
    },
    armed,
    // Before the loop is entered there is no attempt to name; saying "attempt 0
    // of 3" would imply the ticket has already been round once.
    cap: fixAttempts > 0 ? `attempt ${fixAttempts} of ${FIX_ATTEMPT_CAP}` : null,
  };
}
