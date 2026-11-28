/**
 * The Ship stage's auto-fix rounds as one tab sequence (T1410, T1365).
 *
 * UAT and Review already present every loop as a round (`listGateAttempts`).
 * Ship's auto-fix notes (`Autopilot: <conflicts|ci> round n/m`) are the same
 * shape, but they carry no stage run id, so there is nothing to group rows by.
 * This module makes the tabs from the notes alone and joins each round's
 * evidence by TIME WINDOW:
 *
 *   round i covers [at_i, at_{i+1}), the last round [at_n, now)
 *
 * LIMIT of the time-window join: a push that started BEFORE its round's note
 * was written falls into the previous window, and a row whose start is outside
 * every window is dropped. The notes are written when the engine arms the
 * round, so this is rare — and stating the limit is better than inventing a
 * link that no record holds.
 *
 * Pure: no store and no `vscode` import. The host reads the facts; this module
 * only words them (UI-R31).
 */
import { ATTEMPT_TABS_LIMIT, type AttemptKey, type GateAttemptView } from './rounds.js';
import type { AutofixAttempt, AutofixKind, AutofixRound, AutofixStepRow } from './autofix.js';
import { formatTime, type EvidenceRow, type InsideStatus } from './types.js';

/** The visible status word beside a tab's glyph — status is never colour-only. */
const STATUS_LABELS: Readonly<Record<InsideStatus, string>> = {
  pending: 'pending',
  run: 'running',
  wait: 'waiting',
  pass: 'passed',
  fail: 'failed',
  note: 'no result',
  skip: 'skipped',
};

/** The kind word the tab and the caption show: `CI` or `conflict`. */
const tagWord = (kind: AutofixKind): string => (kind === 'ci' ? 'CI' : 'conflict');

/** Why a round opened, in a reader's words. The notes carry no target, so the reason stays at the kind. */
const openedBy = (kind: AutofixKind): string => (kind === 'ci' ? 'opened by a failing check' : 'opened by a merge conflict');

/** Oldest first by the note time. Array position is never trusted. */
function ordered(attempts: readonly AutofixAttempt[]): AutofixAttempt[] {
  return [...attempts].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

/** Index of the first note a spent park names (its newest `used` notes of that kind), or Infinity. */
function spentFrom(all: readonly AutofixAttempt[], spent: ShipSpentPark | null | undefined): number {
  if (!spent) return Infinity;
  const indexes = all.flatMap((a, i) => (a.kind === spent.kind ? [i] : []));
  return indexes.slice(-Math.max(spent.used, 0))[0] ?? Infinity;
}

/** The spent park as `parkedRow` reads it: the kind and the count of the newest rounds that failed. */
export interface ShipSpentPark {
  readonly kind: AutofixKind;
  readonly used: number;
}

export interface ListShipRoundsInput {
  /** Every `Autopilot: <kind> round n/m` note of the ticket, oldest first. */
  readonly attempts: readonly AutofixAttempt[];
  /** The round running now, when one runs. Its newest note of that kind is the live tab. */
  readonly liveRound: AutofixRound | null;
  /** The `auto-fix stopped: <kind> <used>/<max>` park, when on record. */
  readonly spent?: ShipSpentPark | null;
  /** Reserved for callers that share the ledger's clock; the caption states no duration. */
  readonly now: string;
}

/** One round's status: live runs, a later same-kind round failed it, the newest finished round only ran. */
function roundStatus(
  all: readonly AutofixAttempt[],
  index: number,
  liveIndex: number,
  spent: ShipSpentPark | null | undefined,
  spentStart: number,
): InsideStatus {
  if (index === liveIndex) return 'run';
  const kind = all[index]!.kind;
  // A spent park names the NEWEST rounds of its kind; an older note belongs to
  // a budget that was reset or raised, so it keeps its own history status.
  if (spent && kind === spent.kind) return index >= spentStart ? 'fail' : 'note';
  return all.slice(index + 1).some((later) => later.kind === kind) ? 'fail' : 'note';
}

/**
 * The ordered Ship round tabs, across both auto-fix kinds.
 *
 * A stage with fewer than two rounds emits NO tabs, exactly as UAT and Review
 * do. Status never claims a pass for "ran": the live round is `run`, a
 * finished round followed by a round of the same kind is `fail` (the problem
 * was still there), and the newest finished round is `note` — its result is
 * whatever its own rows hold. A spent park turns the rounds it names `fail`
 * and warns `no fix attempts left` on the newest.
 */
export function listShipRounds(input: ListShipRoundsInput): GateAttemptView[] {
  const all = ordered(input.attempts);
  if (all.length < 2) return [];
  const liveKind = input.liveRound?.kind ?? null;
  // The engine writes one note when it arms a round, so the newest note of the
  // running kind is the round in flight (the same rule `finishedAttempts` uses).
  const liveIndex = liveKind === null ? -1 : all.map((a) => a.kind).lastIndexOf(liveKind);
  const spentStart = spentFrom(all, input.spent);
  const spentLast = input.spent ? all.map((a) => a.kind).lastIndexOf(input.spent.kind) : -1;
  const last = all.length - 1;
  const views = all.map((a, i): GateAttemptView => {
    const live = i === liveIndex;
    const status = roundStatus(all, i, liveIndex, input.spent, spentStart);
    const tag = tagWord(a.kind);
    const warning = input.spent && i === spentLast ? 'no fix attempts left' : '';
    return {
      key: `ship:${a.at}` as AttemptKey,
      label: `R${i + 1}`,
      tag,
      tail: `of ${all.length}${live ? ' · live' : ''}`,
      caption: `${tag} round ${a.n} of ${a.max} · ${openedBy(a.kind)}`,
      ...(warning ? { warning } : {}),
      status,
      statusLabel: STATUS_LABELS[status],
      time: formatTime(a.at),
      latest: i === last,
    };
  });
  // Bound to the newest ATTEMPT_TABS_LIMIT, like `listGateAttempts`.
  return views.length > ATTEMPT_TABS_LIMIT ? views.slice(views.length - ATTEMPT_TABS_LIMIT) : views;
}

/** One round's time window: `[from, to)`. */
export interface ShipRoundWindow {
  readonly key: AttemptKey;
  readonly from: string;
  readonly to: string;
}

export interface ShipRoundWindowsInput {
  readonly attempts: readonly AutofixAttempt[];
  readonly now: string;
}

/**
 * The time window of every round. Round i starts at its note and ends when the
 * next note is written; the last round is open until `now`.
 */
export function shipRoundWindows(input: ShipRoundWindowsInput): ShipRoundWindow[] {
  const all = ordered(input.attempts);
  return all.map((a, i) => ({
    key: `ship:${a.at}` as AttemptKey,
    from: a.at,
    to: all[i + 1]?.at ?? input.now,
  }));
}

/** One push a round's window can hold: a ship push step, or an auto-deliver run. */
export interface ShipPushEvidence {
  /** The push's recorded start (ISO). A push with no start cannot be placed in a window. */
  readonly at: string;
  readonly label: string;
  readonly detail?: string;
  readonly status: InsideStatus;
}

/** The CI answer a record holds, host-read (the newest finished round's current check state). */
export interface ShipCiEvidence {
  readonly label: string;
  readonly status: InsideStatus;
}

/**
 * Everything `shipRoundEvidence` needs. `round`/`attempt` identify the
 * selected tab; `steps` is the live round's provable step rows; `pushes`
 * are candidate push rows the window filters; `followedByCi` says another CI
 * round came later (the check was still failing); `currentCi` is the newest
 * finished round's current PR check state.
 */
export interface ShipRoundEvidenceFacts {
  readonly round: GateAttemptView;
  readonly attempt: AutofixAttempt;
  readonly steps?: readonly AutofixStepRow[];
  readonly pushes?: readonly ShipPushEvidence[];
  readonly followedByCi?: boolean;
  readonly currentCi?: ShipCiEvidence | null;
}

/** The CI row the round's own records hold, or undefined. Never an invented result. */
function ciRow(facts: ShipRoundEvidenceFacts): EvidenceRow | undefined {
  const { round, attempt } = facts;
  const live = round.status === 'run';
  if (attempt.kind !== 'ci') {
    // A conflict round states a CI result only as the newest round's current check state.
    return !live && round.latest && facts.currentCi ? { label: facts.currentCi.label, status: facts.currentCi.status } : undefined;
  }
  if (live) return { label: 'CI', detail: 'waits for the push', status: 'pending' };
  if (facts.followedByCi === true) return { label: 'CI', detail: 'CI still failed', status: 'fail' };
  if (round.latest && facts.currentCi) return { label: facts.currentCi.label, status: facts.currentCi.status };
  return undefined;
}

/**
 * One selected round's rows, split by the Ship process that renders them: the
 * Auto-fix rows (the arm row, or the live round's steps), the push rows, and
 * the CI result. The three lists keep the round's time order when read as one.
 */
export interface ShipRoundLedger {
  /** The selected round, for the process status and the caption tail. */
  readonly round: GateAttemptView;
  readonly autofix: readonly EvidenceRow[];
  readonly push: readonly EvidenceRow[];
  readonly ci: readonly EvidenceRow[];
}

/** The Auto-fix rows of the round: the live round's provable steps, else one `ran` row. */
function autofixRows(facts: ShipRoundEvidenceFacts): EvidenceRow[] {
  const { round, attempt } = facts;
  if (round.status === 'run') {
    // The live round has no arm row of its own: its provable steps are the record.
    return (facts.steps ?? []).map((step) => ({ label: step.label, detail: step.detail, status: step.status }));
  }
  const tag = round.tag ?? tagWord(attempt.kind);
  return [
    {
      label: `round ${attempt.n}`,
      detail: `${tag} round ${attempt.n} of ${attempt.max} ran`,
      status: 'note',
      time: formatTime(attempt.at),
    },
  ];
}

/** The push rows whose recorded start falls in the round's window, oldest first. */
function pushRows(window: ShipRoundWindow, facts: ShipRoundEvidenceFacts): EvidenceRow[] {
  return (facts.pushes ?? [])
    .filter((p) => p.at >= window.from && p.at < window.to)
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
    .map((push) => ({
      label: push.label,
      ...(push.detail ? { detail: push.detail } : {}),
      status: push.status,
      time: formatTime(push.at),
    }));
}

/** The CI row the round's own records hold; `[]` when no record holds one. */
function ciRows(facts: ShipRoundEvidenceFacts): EvidenceRow[] {
  const ci = ciRow(facts);
  return ci ? [ci] : [];
}

/**
 * One selected round's rows, split by process. A round with no push record
 * shows no push row; a record that holds no result shows none.
 */
export function shipRoundLedger(window: ShipRoundWindow, facts: ShipRoundEvidenceFacts): ShipRoundLedger {
  return { round: facts.round, autofix: autofixRows(facts), push: pushRows(window, facts), ci: ciRows(facts) };
}

/**
 * One selected round's rows, in time order: the arm row (or the live round's
 * steps), the pushes whose start falls in the round's window, then the CI
 * result. A round with no push record shows no push row; a record that holds
 * no result shows none.
 */
export function shipRoundEvidence(window: ShipRoundWindow, facts: ShipRoundEvidenceFacts): EvidenceRow[] {
  const ledger = shipRoundLedger(window, facts);
  return [...ledger.autofix, ...ledger.push, ...ledger.ci];
}
