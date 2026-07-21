import type { Store } from '../store/db.js';
import type { StageKey } from '../model/types.js';
import { isSafePhaseName, phaseNameFault } from '../approaches/phaseName.js';
import { recordPhaseMark, type PhaseMarkInput } from '../store/phaseMarks.js';
import { stageAttempt } from '../store/stages.js';
import { nowIso } from '../model/time.js';

/**
 * The `karst phase <name>` CLI — the marker an agent fires on ENTERING a phase
 * of its declared workflow, so the panel can say where inside a long impl stage
 * the session is.
 *
 * This is a SEPARATE parse path from `stage`, deliberately, and the separation
 * is the security property:
 *
 *  - `parseStageArgs` narrows to `MARKER_STAGES × {pass}` because the invoking
 *    agent reads ticket content it did not author, so prompt injection reaches
 *    this CLI and `stage ship pass` would force a passed verdict on a gate that
 *    never ran. Widening that parser to also understand phases would put phase
 *    handling inside the one function whose whole job is refusing forged
 *    verdicts.
 *  - So a phase never produces a `Verdict` and this module never imports the
 *    machine. A mark records an event; it must not be able to move a ticket.
 *    The worst a fully-injected `phase` invocation can do is append a row.
 *  - The phase name is re-validated on receipt against the same charset install
 *    uses (`phaseName.ts`). Install-time validation is not a reason to trust
 *    argv: the agent composes this command line itself.
 */

/**
 * The stage a mark attaches to.
 *
 * The argv carries no stage token, so this is fixed rather than derived. Two
 * reasons: the shipped slice is impl-only (the longest, most opaque stage — the
 * one the feature exists for), and deriving from the ticket's *current* stage
 * would let a late-firing marker write a gate key such as `uat` into a column
 * documented as `MARKER_STAGES`, quietly attaching agent-reported evidence to a
 * stage whose verdicts are supposed to come from exit codes alone. A `fix`
 * marker needs a stage token on the wire, which is a later, deliberate change.
 */
export const PHASE_MARK_STAGE: StageKey = 'impl';

export interface ParsedPhase {
  phaseName: string;
}

/**
 * Parse `['phase', <name>]` at the system boundary. Never trusts argv: the name
 * is re-validated against the install-time charset, and any trailing token is
 * refused rather than ignored — that is what stops a caller from smuggling in a
 * timestamp or a stage key later on.
 */
export function parsePhaseArgs(argv: string[]): ParsedPhase {
  const [cmd, phaseName, ...extra] = argv;
  if (cmd !== 'phase') {
    throw new Error(`expected 'phase' command, got '${cmd ?? ''}'`);
  }
  if (phaseName === undefined) {
    throw new Error("missing phase name (want `phase <name>`)");
  }
  if (extra.length > 0) {
    throw new Error(
      `unexpected argument '${extra[0]}' after the phase name — a mark carries a name only ` +
        '(its timestamp and attempt are recorded server-side)',
    );
  }
  if (!isSafePhaseName(phaseName)) {
    throw new Error(phaseNameFault('phase name', phaseName));
  }
  return { phaseName };
}

/** The writes the command performs — injected so it is unit-testable. */
export interface PhaseDeps {
  record: (store: Store, mark: PhaseMarkInput) => void;
  attemptOf: (store: Store, ticketId: number, stageKey: StageKey) => number;
  now: () => string;
}

const DEFAULT_DEPS: PhaseDeps = {
  record: recordPhaseMark,
  attemptOf: stageAttempt,
  now: nowIso,
};

/**
 * Parse argv and append one phase mark for `ticketId`; returns the recorded
 * name. `attempt` is read from the stage row and `markedAt` from the server
 * clock — neither is accepted from argv, so a mark cannot be backdated or
 * attributed to an attempt it did not happen in.
 */
export function runPhaseCommand(
  store: Store,
  ticketId: number,
  argv: string[],
  deps: PhaseDeps = DEFAULT_DEPS,
): string {
  const { phaseName } = parsePhaseArgs(argv);
  deps.record(store, {
    ticketId,
    stageKey: PHASE_MARK_STAGE,
    attempt: deps.attemptOf(store, ticketId, PHASE_MARK_STAGE),
    phaseName,
    markedAt: deps.now(),
  });
  return phaseName;
}
