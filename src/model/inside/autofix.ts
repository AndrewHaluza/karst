/**
 * Auto-fix on the ship panel (T1004, reshaped by T1070; layout: docs/ui/prototypes/inside-cleanup.html C2-C4).
 *
 * Pure wording over facts the host read from the autopilot store (@arch:AP-00). Auto-fix is its own
 * process row (`row`, registry id `autofix`, before Merge) with attempt rows and provable step rows,
 * and it has a blocked banner (`banner`). The park reason is the engine's own string; this module only
 * reads it. A reason it does not know stays visible as written, never hidden.
 *
 * Autopilot never merges (@arch:GH-04) and never fixes a diverged push (@arch:GH-08), so no
 * state here offers either.
 */
export type AutofixOverride = 'inherit' | 'on' | 'off';
export type AutofixKind = 'conflicts' | 'ci';

/** The problem a park or a round is about, as the host resolved it. */
export interface AutofixTarget {
  readonly kind: AutofixKind;
  readonly repo: string;
  readonly pr: number | null;
  /** The failing check (CI only). */
  readonly check: string | null;
  readonly logUrl?: string;
}

export interface AutofixRound extends AutofixTarget {
  readonly used: number;
  readonly max: number;
}

export interface AutofixFacts {
  readonly override: AutofixOverride;
  readonly projectDefault: boolean;
  /** The mode that applies to the ticket (override, else parent, else project default). */
  readonly effective: boolean;
  /** The ship block / paused reason written by the engine (starts with `auto-fix`), or null. */
  readonly reason: string | null;
  readonly round: AutofixRound | null;
  readonly stopAfter: boolean;
  /** `repo #n` labels of open PRs whose CI status is unknown or unreadable. */
  readonly unknownCi: readonly string[];
  readonly target: AutofixTarget | null;
  /** One line per attempt, oldest first (the banner's collapsed history). */
  readonly history?: readonly string[];
  /** Every armed round of both kinds, oldest first, with the time of its Autopilot note (the Auto-fix row's attempt rows). */
  readonly attempts?: readonly AutofixAttempt[];
}

/** One `Autopilot: <kind> round n/m` note: the engine writes it when it arms a round. */
export interface AutofixAttempt {
  readonly kind: AutofixKind;
  readonly n: number;
  readonly max: number;
  /** The note's ISO time. */
  readonly at: string;
}

export type AutofixRowState = 'running' | 'spent' | 'paused' | 'gh-failed' | 'unknown' | 'history';

/** A finished attempt: `ran` while a later round runs, `fails` on a spent park (every attempt failed). */
export interface AutofixAttemptRow {
  readonly label: string;
  readonly detail: string;
  readonly result: 'ran' | 'fails';
  readonly at: string;
}

/** A step of the running attempt. Only a step the host can prove is listed: the engine writes no step signal (@arch:AP-02). */
export interface AutofixStepRow {
  readonly label: string;
  readonly detail: string;
  readonly status: 'pass' | 'run';
  /** The row that holds "Last round" (the running step). */
  readonly stopAfter?: boolean;
}

/** The Auto-fix process row's reading. `steps` is empty unless a round runs. */
export interface AutofixRowView {
  readonly state: AutofixRowState;
  readonly message: string;
  readonly attempts: readonly AutofixAttemptRow[];
  readonly steps: readonly AutofixStepRow[];
  readonly stopAfterRequested: boolean;
}

/** The step rows the host can prove (T1070; these replace the old CI_STEPS / CONFLICT_STEPS chains). */
export const STEP_FETCH_LOG = 'fetch CI log';
export const STEP_CI_AGENT = 'agent fix';
export const STEP_CONFLICT_AGENT = 'agent resolving';

const STOPPED = /^auto-fix stopped: (conflicts|ci) (\d+)\/(\d+)$/;
// The engine's own park for a CI round that did not start (a gh fetch failure refunds the attempt), and the prototype's wording.
const ENGINE_GH = /^auto-fix stopped: ci could not run \((.*)\)$/;
const GH_FAILED = /^auto-fix (?:paused: could not read CI\b|stopped: ci could not run \()/;
const SANDBOX_WORD = /sandbox/i;
// A permanent park (a graph ticket): the cause is the ticket kind, so a retry parks again. A sandbox park keeps ONE Retry (the ticket requires it).
const NOT_RUN = /^auto-fix not run:/;
const SANDBOXED = 'auto-fix not run: sandboxed ticket';

const prLabel = (t: AutofixTarget): string => (t.pr === null ? t.repo : `${t.repo} #${t.pr}`);
/** ` on web #421`, or nothing when the host could not name the PR. */
const onPr = (t: AutofixTarget): string => (prLabel(t) === '' ? '' : ` on ${prLabel(t)}`);
const capitalize = (s: string): string => (s === '' ? s : `${s[0]!.toUpperCase()}${s.slice(1)}`);

const kindWord = (kind: AutofixKind): string => (kind === 'ci' ? 'CI' : 'conflict');
const unitWord = (kind: AutofixKind): string => (kind === 'ci' ? 'attempt' : 'round');

/** The step rows the host can prove. A CI round has fetched its log (the host does that before the hand-off) and the agent works. */
function provableSteps(round: AutofixRound): readonly AutofixStepRow[] {
  if (round.kind === 'ci') {
    return [
      { label: STEP_FETCH_LOG, detail: round.check ? `gh · ${round.check}` : 'gh', status: 'pass' },
      { label: STEP_CI_AGENT, detail: `${unitWord('ci')} ${round.used}`, status: 'run', stopAfter: true },
    ];
  }
  return [{ label: STEP_CONFLICT_AGENT, detail: `${unitWord('conflicts')} ${round.used}`, status: 'run', stopAfter: true }];
}

/** The attempt row of a finished round. A spent park says every attempt failed; a running row states no result (the host has none). */
function attemptRow(a: AutofixAttempt, failed: boolean, target: AutofixTarget | null): AutofixAttemptRow {
  const subject = a.kind === 'ci' ? `CI ${target?.check ?? 'check'}` : 'conflict';
  return {
    label: `${unitWord(a.kind)} ${a.n}`,
    detail: failed ? `${subject} still ${a.kind === 'ci' ? 'fails' : 'there'}` : `${kindWord(a.kind)} ${unitWord(a.kind)} ${a.n} of ${a.max} ran`,
    result: failed ? 'fails' : 'ran',
    at: a.at,
  };
}

/** The finished attempts. While a round runs, its own note is the newest of its kind and is not finished yet. */
function finishedAttempts(f: AutofixFacts, failedKind: AutofixKind | null): readonly AutofixAttemptRow[] {
  const all = f.attempts ?? [];
  const running = f.round?.kind ?? null;
  const skip = running === null ? -1 : all.map((a) => a.kind).lastIndexOf(running);
  return all.flatMap((a, i) => (i === skip ? [] : [attemptRow(a, a.kind === failedKind, f.target)]));
}

function runningRow(f: AutofixFacts, round: AutofixRound): AutofixRowView {
  const isCi = round.kind === 'ci';
  return {
    state: 'running',
    message: isCi
      ? `CI ${round.check ?? 'check'}${onPr(round)} · attempt ${round.used} of ${round.max}`
      : `conflict${onPr(round)} · round ${round.used} of ${round.max}`,
    attempts: finishedAttempts(f, null),
    steps: provableSteps(round),
    stopAfterRequested: f.stopAfter,
  };
}

function parkedRow(f: AutofixFacts, reason: string): AutofixRowView {
  const spent = STOPPED.exec(reason);
  const base = { steps: [], stopAfterRequested: false } as const;
  if (spent) {
    const [, kind, used, max] = spent;
    const k = kind as AutofixKind;
    const subject = k === 'ci' ? `CI ${f.target?.check ?? 'check'}` : 'conflict';
    const where = f.target ? ` on ${prLabel(f.target)}` : '';
    const message = `stopped: ${subject}${where} · ${used} of ${max} ${k === 'ci' ? 'attempts' : 'rounds'}`;
    return { ...base, state: 'spent', message, attempts: finishedAttempts(f, k) };
  }
  const attempts = finishedAttempts(f, null);
  if (GH_FAILED.test(reason)) {
    // The engine park reads as the specified row: "could not read CI (gh: <error>)".
    const engine = ENGINE_GH.exec(reason);
    const inner = engine?.[1] ?? '';
    const message = engine ? `paused: could not read CI (${/^gh\b/.test(inner) ? inner : `gh: ${inner}`})` : reason.replace(/^auto-fix /, '');
    return { ...base, state: 'gh-failed', message, attempts };
  }
  if (reason === SANDBOXED) return { ...base, state: 'paused', message: 'paused: sandbox ticket (autopilot runs host tickets only)', attempts };
  return { ...base, state: 'paused', message: reason.replace(/^auto-fix /, ''), attempts };
}

/**
 * The Auto-fix row's reading, or null when the row is omitted: autopilot must apply to the ticket, and a round, a park, an attempt
 * on record or an unknown CI status gives it something to say. A running round wins over a stale park.
 */
export function autofixRow(f: AutofixFacts): AutofixRowView | null {
  if (!f.effective) return null;
  if (f.round) return runningRow(f, f.round);
  if (f.reason !== null && f.reason.startsWith('auto-fix')) return parkedRow(f, f.reason);
  // Unknown CI status is never a pass (@arch:GH-03): the row says the engine waits.
  if (f.unknownCi.length > 0) {
    return {
      state: 'unknown',
      message: `CI status unknown for ${f.unknownCi.join(', ')}. Auto-fix waits; not counted as pass.`,
      attempts: finishedAttempts(f, null),
      steps: [],
      stopAfterRequested: false,
    };
  }
  // Earlier attempts alone still give the row: it lists them and states no result it cannot prove.
  const earlier = finishedAttempts(f, null);
  if (earlier.length > 0) {
    return { state: 'history', message: `${earlier.length} earlier ${earlier.length === 1 ? 'attempt' : 'attempts'}`, attempts: earlier, steps: [], stopAfterRequested: false };
  }
  return null;
}

/** One button of the banner: `act` is the dashboard `data-act`. */
export interface AutofixBannerAction {
  readonly act: string;
  /** The short visible label (icon + 1-2 words, UI-R21). */
  readonly label: string;
  /** The `Icon` name beside the label. Absent → a text-only button. */
  readonly icon?: string;
  /** The full sentence: it is the title and, after the label, the accessible name. */
  readonly title?: string;
  readonly repo?: string;
  readonly kind?: AutofixKind;
}

export type AutofixBannerState = 'spent' | 'gh-failed' | 'paused';

/** The blocked banner's body for an auto-fix park (@arch:BLOCKED: no new blocker kind). */
export interface AutofixBannerView {
  readonly state: AutofixBannerState;
  /** The check name (a link to its log when the host knows the URL), else the plain title. */
  readonly title: string;
  readonly titleHref?: string;
  readonly titleSuffix: string;
  readonly cause: string;
  /** Null for a permanent park (`auto-fix not run: …`): a Retry would only park again. */
  readonly primary: AutofixBannerAction | null;
  readonly secondary: AutofixBannerAction | null;
  readonly history: readonly string[];
}

const RETRY: AutofixBannerAction = { act: 'autopilot-retry', label: 'Retry' };
const SYNC_DIFF: AutofixBannerAction = { act: 'sandbox-diff', label: 'Open sync diff' };

function spentBanner(f: AutofixFacts, used: string, max: string, kind: AutofixKind): AutofixBannerView {
  const t = f.target;
  const history = f.history ?? [];
  const isCi = kind === 'ci';
  return {
    state: 'spent',
    title: isCi ? (t?.check ?? 'CI') : 'Merge conflict',
    ...(isCi && t?.logUrl ? { titleHref: t.logUrl } : {}),
    titleSuffix: t ? `${isCi ? 'failed on ' : 'on '}${prLabel(t)}` : isCi ? 'failed' : '',
    cause: isCi
      ? `Auto-fix tried ${used} of ${max} times and the check still fails.`
      : `Auto-fix resolved the conflict in ${used} of ${max} rounds and it is still there.`,
    primary: {
      act: 'autopilot-approve-one',
      label: isCi ? '+1 attempt' : '+1 round',
      icon: 'refresh',
      title: isCi ? 'Approve 1 more auto-fix attempt' : 'Approve 1 more auto-fix round',
      ...(t ? { repo: t.repo } : {}),
      kind,
    },
    secondary: isCi
      ? { act: 'send-ci-failure', label: 'Send back…', icon: 'arrow-left', title: 'Send the CI failure to the agent with a note' }
      : { act: 'resolve-conflicts', label: 'Resolve by hand…', icon: 'pencil', title: 'Resolve conflicts by hand', ...(t ? { repo: t.repo } : {}) },
    history,
  };
}

/** The banner for an auto-fix park, or null when no auto-fix reason is on record. */
export function autofixBanner(f: AutofixFacts): AutofixBannerView | null {
  const reason = f.reason;
  if (reason === null || !reason.startsWith('auto-fix')) return null;
  const spent = STOPPED.exec(reason);
  if (spent) return spentBanner(f, spent[2]!, spent[3]!, spent[1] as AutofixKind);
  if (GH_FAILED.test(reason)) {
    return {
      state: 'gh-failed',
      title: 'Auto-fix paused',
      titleSuffix: 'could not read CI',
      cause: capitalize(reason.replace(/^auto-fix (?:paused|stopped): (?:ci )?/, (m) => (m.endsWith('ci ') ? 'CI ' : ''))),
      primary: RETRY,
      secondary: null,
      history: [],
    };
  }
  // A sandbox pause did not use the budget: ONE Retry, and the existing sandbox actions sit beside it (never run on host).
  return {
    state: 'paused',
    title: 'Auto-fix paused',
    titleSuffix: reason === SANDBOXED ? 'sandbox ticket' : '',
    cause: reason === SANDBOXED ? 'The sandbox cannot run a round. Fix the sandbox, then retry.' : NOT_RUN.test(reason) ? `${capitalize(reason)}.` : `${capitalize(reason)}. Fix the cause, then retry.`,
    primary: NOT_RUN.test(reason) && !SANDBOX_WORD.test(reason) ? null : RETRY,
    secondary: SANDBOX_WORD.test(reason) ? SYNC_DIFF : null,
    history: [],
  };
}
