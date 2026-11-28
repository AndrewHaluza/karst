import { displayStatus, type StepperCell } from '../../model/stepper.js';
import type { StageKey } from '../../model/types.js';
import type { InsideStageKey } from '../../model/inside/types.js';
import { insideStageForRuntimeStage } from '../../model/inside/registry.js';
import { listGateAttempts, type AttemptKey, type GateAttemptView } from '../../model/inside/rounds.js';
import { listShipRounds, type ShipSpentPark } from '../../model/inside/shipRounds.js';
import type { AutofixAttempt, AutofixRound } from '../../model/inside/autofix.js';
import { currentAttemptFor, type CurrentAttempt } from '../../model/inside/currentAttempt.js';
import type { RecoveryRound } from '../../store/recoveryRounds.js';
import type { AttemptSwitch, AttemptSwitchView, RoundSwitcherArg } from './stateInside.js';


// The round switcher's effective selection for one gate stage (T4): the
// requested key if some recorded attempt actually holds it, otherwise the
// newest attempt. A stage with 0 or 1 attempt emits no tabs at all (T1's
// own contract), so `attemptSwitcherFor` degrades to "nothing to select"
// without a caller here having to special-case the un-looped ticket.
export const attemptSwitcherFor = (
  attempts: readonly GateAttemptView[],
  requested: string | undefined,
  // True when the host's `currentAttemptFor` returned an explicit `null`
  // for this stage (the re-entry window — see `rounds.ts`'s
  // `reentryPending`). The tab flagged `latest` in that state is NOT the
  // live invocation; it is the newest SETTLED attempt, kept flagged `latest`
  // only so the default (unclicked) view still resolves to `null` below.
  reentryPending: boolean,
): {
  selectedKey: AttemptKey | null;
  view?: AttemptSwitchView;
} => {
  if (attempts.length < 2) return { selectedKey: null };
  const requestedMatch = requested !== undefined ? attempts.find((a) => a.key === requested) : undefined;
  const effective = requestedMatch ?? attempts.find((a) => a.latest);
  if (effective === undefined) return { selectedKey: null };
  // Host-authored (UI-R31): the selected round's own facts, verbatim. The
  // caption is a plain statement (why the round opened, how long it took) and
  // belongs in the tab row; only the WARNING — the fact the reader must act
  // on — is allowed to occupy the attention band.
  const attemptCaption = effective.caption;
  const attemptNote = effective.warning;
  // An EXPLICIT click on the re-entry window's `latest`-flagged tab must
  // still reach that attempt's own recorded rows — it is a settled attempt,
  // not the live one, and collapsing it to `null` here is exactly what made
  // its evidence show as an empty ledger no matter which tab a reader
  // picked (Finding 1). Only the UNCLICKED default keeps mapping to `null`,
  // which is what lets the ledger stay empty absent a click (`effectiveAttempt`
  // in gates.ts empties on a `null` selection while the current invocation
  // has recorded nothing).
  const reachThroughLatest = reentryPending && effective.latest && requestedMatch !== undefined;
  return {
    // The LATEST tab is the default path, so it selects `null` — not its own
    // key. A key restricts every downstream read to rows that carry a stage
    // run id, and a `process_runs` row written before v25 carries none:
    // selecting the latest key would have emptied the Tester/Review evidence
    // of exactly the view that renders by default. `null` is the read the
    // panel has always done, so the default view stays byte-for-byte itself
    // and only a HISTORICAL selection narrows anything.
    selectedKey: effective.latest && !reachThroughLatest ? null : effective.key,
    view: {
      attempts,
      selectedAttempt: effective.key,
      ...(attemptCaption ? { attemptCaption } : {}),
      ...(attemptNote ? { attemptNote } : {}),
    },
  };
};


// The stage the six-stage presentation shows as CURRENT: `fix` projects onto
// the stage its active recovery round is causally attached to. A ship-sourced

/**
 * Merges a `supersededNote` fallback into an `attemptSwitcherFor` view for
 * `stageView`'s `roundSwitcher` argument. An attempt's own WARNING (no fix
 * attempts left) always wins — it is the more specific fact, and a
 * superseded-round banner must never paper over it. The selected attempt's
 * CAPTION passes through untouched: it is a plain statement, so it never
 * competes for the band. Absent a switcher view entirely, the superseded note
 * stands alone as the note-only shape `stageView` also accepts.
 */
const withNote = (
  view: AttemptSwitchView | undefined,
  note: string | undefined,
): AttemptSwitchView | { attemptNote: string } | undefined =>
  view
    ? view.attemptNote
      ? view
      : { ...view, ...(note ? { attemptNote: note } : {}) }
    : note
      ? { attemptNote: note }
      : undefined;

export interface GateSwitchesInput {
  ticket: { stageCurrent: string | null };
  rounds: readonly RecoveryRound[];
  gateRuns: GateAttemptsInput['gateRuns'];
  processRuns: GateAttemptsInput['processRuns'];
  cellOf: (key: StageKey) => StepperCell;
  stageRuns: Parameters<typeof currentAttemptFor>[0];
  attemptSelection?: Partial<Record<'uat' | 'review' | 'ship', string>>;
  /** The Ship auto-fix notes, live round, spent park and clock the round tabs read (T1410). */
  shipRounds?: {
    attempts: readonly AutofixAttempt[];
    liveRound: AutofixRound | null;
    spent?: ShipSpentPark | null;
    now: string;
  };
}

type GateAttemptsInput = Parameters<typeof listGateAttempts>[0];

/**
 * The recovery-round projection of one snapshot: the stage presented as
 * CURRENT and each gate stage's round switcher (tabs, effective selection and
 * the superseded-round note), all from the one set of reads the caller passes.
 */
export function buildGateSwitches(input: GateSwitchesInput): {
  presentedStage: InsideStageKey;
  uatCurrent: CurrentAttempt;
  reviewCurrent: CurrentAttempt;
  uatSwitch: AttemptSwitch;
  reviewSwitch: AttemptSwitch;
  shipSwitch: AttemptSwitch;
  uatRoundSwitcher: RoundSwitcherArg;
  reviewRoundSwitcher: RoundSwitcherArg;
  shipRoundSwitcher: RoundSwitcherArg;
} {
  const { ticket, rounds, gateRuns, processRuns, stageRuns, cellOf, attemptSelection, shipRounds } = input;
  // The gate stage's CURRENT invocation (`model/inside/currentAttempt.ts`),
  // resolved once per stage and shared by the round switcher and the quality
  // reducer below — two reads of `stage_runs` is how a tab and a ledger end
  // up disagreeing about which attempt is showing.
  const currentAttemptOf = (key: 'uat' | 'review') =>
    currentAttemptFor(stageRuns, key, cellOf(key).startedAt);
  const uatCurrent = currentAttemptOf('uat');
  const reviewCurrent = currentAttemptOf('review');

  // The stage the six-stage presentation shows as CURRENT: `fix` projects onto
  // the stage its active recovery round is causally attached to. A ship-sourced
  // round (FEAT-40) revalidates through uat first, so it projects onto uat
  // exactly as a uat round does.
  const activeRound = rounds.find(
    (r) =>
      r.status === 'pending' ||
      r.status === 'fixing' ||
      r.status === 'revalidating' ||
      r.status === 'interrupted',
  );
  const fixFallback: 'uat' | 'review' = activeRound?.sourceStage === 'review' ? 'review' : 'uat';

  /**
   * Host-authored banner for a gate stage whose recorded result is already
   * being superseded (UI-R31 — the webview renders this verbatim).
   *
   * While a recovery round works elsewhere, the OTHER gate stage still holds
   * its last verdict: red gates, blocking findings, and nothing on screen
   * saying a fix has since landed and the stage re-runs. Nothing here invents
   * a status — the result shown is the real last one — it states the fact that
   * makes it readable.
   *
   * Never for the stage the ticket is on (its own ledger is live), never for a
   * stage running right now, and never for a stage with no recorded end: there
   * is no superseded result to caption.
   */
  const supersededNote = (key: 'uat' | 'review'): string | undefined => {
    if (activeRound === undefined) return undefined;
    if (ticket.stageCurrent === key) return undefined;
    const cell = cellOf(key);
    if (displayStatus(cell) === 'running' || displayStatus(cell) === 'blocked') return undefined;
    const endedAt = cell.endedAt;
    if (endedAt === undefined) return undefined;
    // Only a result the round POSTDATES is superseded by it. A stage that ran
    // after the round opened (uat revalidating a review-origin round) is
    // reporting on the fixed tree already.
    if (activeRound.startedAt < endedAt) return undefined;
    return `round ${activeRound.round} is fixing — this result predates that fix, and this stage re-runs`;
  };
  const presentedStage: InsideStageKey =
    ticket.stageCurrent === null || ticket.stageCurrent === 'fix'
      ? insideStageForRuntimeStage(
          (ticket.stageCurrent === 'fix' ? fixFallback : 'scope') as StageKey,
          fixFallback,
        )
      : insideStageForRuntimeStage(ticket.stageCurrent as StageKey, fixFallback);

  // The round switcher's tabs and effective selection, one read per gate
  // stage, shared by the process reducer (which batch/run backs the ledger)
  // and the stage shell (which tab renders selected, and the banner). Two
  // reads of this would risk the ledger and the tab disagreeing about which
  // attempt is showing.
  const uatAttempts = listGateAttempts({
    gateRuns,
    processRuns,
    rounds,
    stageKey: 'uat',
    running: displayStatus(cellOf('uat')) === 'running',
    currentAttempt: uatCurrent ?? null,
    // `=== null` (not `?? null`) so a legacy ticket's `undefined` never reads
    // as re-entry pending — only an explicit `null` from `currentAttemptFor`
    // does.
    reentryPending: uatCurrent === null,
  });
  const uatSwitch = attemptSwitcherFor(uatAttempts, attemptSelection?.uat, uatCurrent === null);
  const reviewAttempts = listGateAttempts({
    gateRuns,
    processRuns,
    rounds,
    stageKey: 'review',
    running: displayStatus(cellOf('review')) === 'running',
    currentAttempt: reviewCurrent ?? null,
    reentryPending: reviewCurrent === null,
  });
  const reviewSwitch = attemptSwitcherFor(reviewAttempts, attemptSelection?.review, reviewCurrent === null);

  // The Ship stage's own round sequence (T1410): one tab row across the
  // conflict and CI rounds, keyed by the Autopilot note's time. The newest
  // round is the default path (`selectedKey: null`), so the default Ship ledger
  // stays exactly as it renders today; only a historical tab narrows it.
  const shipAttempts = listShipRounds({
    attempts: shipRounds?.attempts ?? [],
    liveRound: shipRounds?.liveRound ?? null,
    spent: shipRounds?.spent ?? null,
    now: shipRounds?.now ?? '',
  });
  const shipSwitch = attemptSwitcherFor(shipAttempts, attemptSelection?.ship, false);

  // Hoisted once each — `supersededNote` is otherwise called twice per stage
  // below (once to decide the merge, once to build the note-only fallback).
  const uatNote = supersededNote('uat');
  const reviewNote = supersededNote('review');

  // The round switcher's rendered argument per gate stage: the switcher's own
  // selection/banner merged with the superseded-round note once here, so the
  // tab and the note can never be composed from two different reads.
  const uatRoundSwitcher: RoundSwitcherArg = withNote(uatSwitch.view, uatNote);
  const reviewRoundSwitcher: RoundSwitcherArg = withNote(reviewSwitch.view, reviewNote);
  // Ship has no other gate whose superseded result could need a note: the
  // round's own warning (`no fix attempts left`) already rides its view.
  const shipRoundSwitcher: RoundSwitcherArg = shipSwitch.view;

  return {
    presentedStage,
    uatCurrent,
    reviewCurrent,
    uatSwitch, reviewSwitch, shipSwitch, uatRoundSwitcher, reviewRoundSwitcher, shipRoundSwitcher };
}
