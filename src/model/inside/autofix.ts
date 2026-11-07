/**
 * Auto-fix on the ship panel (T1004; layout: docs/ui/prototypes/autopilot-inapp-v2.html).
 *
 * Pure wording over facts the host read from the autopilot store (@arch:AP-00). There is no
 * new step row: the state lands on the existing Merge row (`row`) and on the existing
 * blocked banner (`banner`). The park reason is the engine's own string; this module only
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
  /** Index into the step line of this kind; 0 when the host cannot tell. */
  readonly step: number;
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
}

export type AutofixRowState = 'running' | 'spent' | 'paused' | 'gh-failed' | 'unknown';

/** The Merge row's auto-fix reading. `steps` is empty unless a round runs. */
export interface AutofixRowView {
  readonly state: AutofixRowState;
  readonly message: string;
  readonly steps: readonly string[];
  readonly activeStep: number;
  readonly stopAfterRequested: boolean;
}

export const CONFLICT_STEPS: readonly string[] = ['agent resolving', 'running gates', 'karst delivers to PR', 're-probe'];
export const CI_STEPS: readonly string[] = ['host fetched log (gh)', 'agent fixing', 'gates', 'push', 'wait for CI'];

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

function runningRow(f: AutofixFacts, round: AutofixRound): AutofixRowView {
  const isCi = round.kind === 'ci';
  const steps = isCi ? CI_STEPS : CONFLICT_STEPS;
  return {
    state: 'running',
    message: isCi
      ? `Auto-fix: CI ${round.check ?? 'check'} failed${onPr(round)} · attempt ${round.used} of ${round.max}`
      : `Auto-fix: conflict${onPr(round)} · round ${round.used} of ${round.max}`,
    steps,
    activeStep: Math.min(Math.max(round.step, 0), steps.length - 1),
    stopAfterRequested: f.stopAfter,
  };
}

function parkedRow(f: AutofixFacts, reason: string): AutofixRowView {
  const spent = STOPPED.exec(reason);
  const base = { steps: [], activeStep: 0, stopAfterRequested: false } as const;
  if (spent) {
    const [, kind, used, max] = spent;
    const where = f.target ? ` on ${prLabel(f.target)}` : '';
    const message = kind === 'ci'
      ? `Auto-fix stopped: CI failed ${used} of ${max} attempts${where}`
      : `Auto-fix stopped: conflicts in ${used} of ${max} rounds${where}`;
    return { ...base, state: 'spent', message };
  }
  if (GH_FAILED.test(reason)) {
    // The engine park reads as the specified row: "could not read CI (gh: <error>)".
    const engine = ENGINE_GH.exec(reason);
    const inner = engine?.[1] ?? '';
    const message = engine ? `Auto-fix paused: could not read CI (${/^gh\b/.test(inner) ? inner : `gh: ${inner}`})` : capitalize(reason);
    return { ...base, state: 'gh-failed', message };
  }
  if (reason === SANDBOXED) return { ...base, state: 'paused', message: 'Auto-fix paused: sandbox ticket (autopilot runs host tickets only)' };
  return { ...base, state: 'paused', message: capitalize(reason) };
}

/** The auto-fix state of the Merge row, or null when there is nothing to say. A running round wins over a stale park. */
export function autofixRow(f: AutofixFacts): AutofixRowView | null {
  if (f.round) return runningRow(f, f.round);
  if (f.reason !== null && f.reason.startsWith('auto-fix')) return parkedRow(f, f.reason);
  // Unknown CI status is never a pass (@arch:GH-03): the row says the engine waits.
  if (f.effective && f.unknownCi.length > 0) {
    return {
      state: 'unknown',
      message: `CI status unknown for ${f.unknownCi.join(', ')}. Auto-fix waits; not counted as pass.`,
      steps: [],
      activeStep: 0,
      stopAfterRequested: false,
    };
  }
  return null;
}

/** One button of the banner: `act` is the dashboard `data-act`. */
export interface AutofixBannerAction {
  readonly act: string;
  readonly label: string;
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
      label: isCi ? 'Approve 1 more attempt' : 'Approve 1 more round',
      ...(t ? { repo: t.repo } : {}),
      kind,
    },
    secondary: isCi ? { act: 'send-ci-failure', label: 'Send CI failure with a note…' } : { act: 'resolve-conflicts', label: 'Resolve conflicts by hand…', ...(t ? { repo: t.repo } : {}) },
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
