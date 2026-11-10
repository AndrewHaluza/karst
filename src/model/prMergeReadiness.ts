import type { MergeCheckRow } from '../store/mergeChecks.js';
import type { PrChecks, MergeBlock } from './prChecks.js';
import type { PrReviewDecision } from './prReview.js';
import { formatAge } from './age.js';

/**
 * Why a pull request can or cannot merge, one reason per cause.
 *
 * GitHub's `mergeStateStatus=BLOCKED` carries no reason, so the list is built from the facts karst
 * holds: the review state, the CI rollup, karst's own merge check and the `behind` verdict. When
 * GitHub refuses and none of them explains it, an honest fallback row says so. karst never claims
 * "no conflicts" without a check (arch:GH-03). Pure: no store, no clock (`now` is injected).
 *
 * The Autopilot input is read from the host's existing reading (arch:AP-00, arch:AP-02); this module
 * adds no engine rule.
 */

export type ReasonState = 'bad' | 'warn' | 'run' | 'ok';
export type ReasonKind = 'draft' | 'review' | 'checks' | 'conflicts' | 'behind' | 'github-rule';
export type ReasonAct = 'open-pr' | 'address-pr-feedback' | 'send-ci-failure' | 'resolve-conflicts' | 'rebase-on-base';

export interface ReasonAction {
  readonly act: ReasonAct;
  readonly label: string;
  /** The PR url (`open-pr`) or the repo (`resolve-conflicts`) the control needs. */
  readonly url?: string;
  readonly repo?: string;
}

export interface ReasonListItem {
  readonly text: string;
  readonly url?: string;
}

export interface Reason {
  readonly kind: ReasonKind;
  readonly state: ReasonState;
  readonly label: string;
  readonly detail: string;
  /** A second detail line (an Autopilot park reason or the unknown-CI wait). */
  readonly extra?: string;
  readonly action?: ReasonAction;
  readonly list?: readonly ReasonListItem[];
  readonly listNote?: string;
  /** The text under a "why karst could not tell" disclosure. */
  readonly why?: string;
  /** The disclosure summary for `why`/`list`. */
  readonly disclosure?: string;
}

export interface PrMergeReadiness {
  readonly ready: boolean;
  readonly headline: string;
  readonly facts: string;
  readonly reasons: readonly Reason[];
}

/** What the host offers: an action is attached to a reason only when it is available. */
export interface ReadinessOffers {
  readonly ciRepos: readonly string[];
  readonly ciAvailable: boolean;
  readonly rebaseAvailable: boolean;
  readonly feedbackAvailable: boolean;
}

export const NO_OFFERS: ReadinessOffers = {
  ciRepos: [],
  ciAvailable: false,
  rebaseAvailable: false,
  feedbackAvailable: false,
};

export type AutofixKindInput = 'ci' | 'conflicts';

/** The Autopilot reading, as the host built it from `AutofixFacts` (the same one the Inside Merge row uses). */
export interface AutofixInput {
  readonly effective: boolean;
  readonly running: { readonly kind: AutofixKindInput; readonly repo: string | null; readonly round: string } | null;
  readonly parked: { readonly kind: AutofixKindInput; readonly reason: string } | null;
  readonly unknownCi: boolean;
}

export const NO_AUTOFIX: AutofixInput = { effective: false, running: null, parked: null, unknownCi: false };

/** The facts of one PR the model reads. */
export interface ReadinessPr {
  readonly repo: string;
  readonly url: string | null;
  readonly status: string;
  readonly baseRef: string | null;
  readonly canMerge: boolean;
  readonly mergeBlock: MergeBlock;
  readonly checks: PrChecks | null;
  readonly reviewDecision: PrReviewDecision;
  readonly approvals: number | null;
  /** Required approving reviews, or null (karst does not fetch it; unknown stays unknown). */
  readonly requiredApprovals: number | null;
  readonly reviewRequests: readonly string[];
}

const AUTOFIX_WAIT = 'Auto-fix waits; not counted as pass';
const FALLBACK_DETAIL = 'not review, checks or conflicts — e.g. signed commits, merge queue, required deployment, or branch must be up to date';

const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`;

function openPr(pr: ReadinessPr): ReasonAction | undefined {
  return pr.url ? { act: 'open-pr', label: 'Open on GitHub', url: pr.url } : undefined;
}

function reviewReason(pr: ReadinessPr, offers: ReadinessOffers): Reason | null {
  switch (pr.reviewDecision) {
    case 'CHANGES_REQUESTED': {
      const action: ReasonAction | undefined = offers.feedbackAvailable
        ? { act: 'address-pr-feedback', label: 'Address feedback' }
        : openPr(pr);
      return { kind: 'review', state: 'bad', label: 'Changes requested', detail: 'a reviewer asked for changes', ...(action ? { action } : {}) };
    }
    case 'REVIEW_REQUIRED': {
      const action = openPr(pr);
      const detail =
        pr.requiredApprovals !== null
          ? `${pr.approvals ?? 0} of ${pr.requiredApprovals} approving reviews`
          : pr.reviewRequests.length > 0
            ? `requested from ${pr.reviewRequests.join(', ')}`
            : 'an approving review is required';
      return { kind: 'review', state: 'bad', label: 'Review required', detail, ...(action ? { action } : {}) };
    }
    case 'APPROVED':
      return {
        kind: 'review',
        state: 'ok',
        label: 'Approved',
        detail: pr.approvals !== null && pr.approvals > 0 ? plural(pr.approvals, 'approving review') : 'by a reviewer',
      };
    default:
      return null;
  }
}

/** The auto-fix wording for a reason of `kind`: what it replaces or adds. */
function autofixFor(
  kind: AutofixKindInput,
  pr: ReadinessPr,
  autofix: AutofixInput,
): { running: string | null; parked: string | null } {
  const run = autofix.running;
  const runs = run !== null && run.kind === kind && (run.repo === null || run.repo === pr.repo);
  const park = autofix.parked;
  return {
    running: runs ? `Auto-fix round ${run.round} runs` : null,
    parked: park !== null && park.kind === kind ? park.reason : null,
  };
}

function checksReason(pr: ReadinessPr, offers: ReadinessOffers, autofix: AutofixInput): Reason | null {
  const c = pr.checks;
  if (c === null || c.state === 'none' || c.state === 'unknown') return null;
  const split = c.required ?? null;
  const fix = autofixFor('ci', pr, autofix);
  const waits = autofix.effective && autofix.unknownCi ? AUTOFIX_WAIT : undefined;
  if (c.state === 'failing') {
    const optionalPending = split ? Math.max(c.pending - split.pending, 0) : c.pending;
    // Only a split that counts a failed required check may say "required"; otherwise the failures are optional or unsplit.
    const requiredFailing = split !== null && split.failed > 0;
    const label = requiredFailing ? 'Required checks failing' : split ? 'Optional checks failing' : 'Checks failing';
    const detail = requiredFailing
      ? `${split.failed} of ${split.total} required failing${optionalPending > 0 ? ` · ${optionalPending} optional pending` : ''}`
      : split
        ? `${plural(c.failed, 'optional check')} failing`
        : `${plural(c.failed, 'check')} failing`;
    const list = c.failing.map((f) => ({ text: f.name, ...(f.url ? { url: f.url } : {}) }));
    const note = c.failedShown < c.failed ? `— first ${c.failedShown} of ${c.failed} shown` : undefined;
    if (fix.running !== null) {
      return { kind: 'checks', state: 'run', label, detail: fix.running, list, ...(note ? { listNote: note } : {}) };
    }
    const canSend = offers.ciAvailable && offers.ciRepos.includes(pr.repo);
    const extra = fix.parked ?? waits;
    return {
      kind: 'checks',
      state: 'bad',
      label,
      detail,
      ...(extra ? { extra } : {}),
      ...(canSend ? { action: { act: 'send-ci-failure', label: 'Send CI failure' } satisfies ReasonAction } : {}),
      list,
      ...(note ? { listNote: note } : {}),
    };
  }
  if (c.state === 'pending') {
    return {
      kind: 'checks',
      state: 'run',
      label: 'Checks running',
      detail: `${c.pending} of ${c.total} pending`,
      ...(waits ? { extra: waits } : {}),
    };
  }
  return { kind: 'checks', state: 'ok', label: 'Checks passed', detail: `${c.passed} of ${c.total}` };
}

function conflictsReason(
  pr: ReadinessPr,
  check: MergeCheckRow | undefined,
  now: string,
  autofix: AutofixInput,
): Reason | null {
  if (check === undefined) return null;
  const base = check.baseRef ?? pr.baseRef ?? 'its base';
  const age = formatAge(check.checkedAt, now);
  const checked = age ? `checked ${age}` : '';
  const join = (...parts: string[]): string => parts.filter((p) => p !== '').join(' · ');
  if (check.state === 'conflicted') {
    const fix = autofixFor('conflicts', pr, autofix);
    const list = check.files.map((text) => ({ text }));
    if (fix.running !== null) {
      return { kind: 'conflicts', state: 'run', label: `Conflicts with ${base}`, detail: fix.running, list };
    }
    return {
      kind: 'conflicts',
      state: 'warn',
      label: `Conflicts with ${base}`,
      detail: join(plural(check.files.length, 'file'), checked),
      ...(fix.parked ? { extra: fix.parked } : {}),
      action: { act: 'resolve-conflicts', label: 'Resolve', repo: pr.repo },
      list,
    };
  }
  if (check.state === 'unknown') {
    return {
      kind: 'conflicts',
      state: 'warn',
      label: 'Conflicts unknown',
      detail: join(`vs ${base}`, checked),
      ...(check.reason ? { disclosure: 'why karst could not tell', why: check.reason } : {}),
    };
  }
  return { kind: 'conflicts', state: 'ok', label: 'No conflicts', detail: join(`vs ${base}`, checked) };
}

const isBad = (r: Reason): boolean => r.state === 'bad' || r.state === 'warn';

/** Why this pull request can or cannot merge — see the module comment. */
export function prMergeReadiness(
  pr: ReadinessPr,
  mergeCheck: MergeCheckRow | undefined,
  offers: ReadinessOffers,
  autofix: AutofixInput,
  now: string,
): PrMergeReadiness {
  if (pr.status === 'merged' || pr.status === 'closed') {
    return { ready: false, headline: '', facts: '', reasons: [] };
  }
  const reasons: Reason[] = [];
  if (pr.status === 'draft') {
    const action = openPr(pr);
    reasons.push({ kind: 'draft', state: 'bad', label: 'Draft', detail: 'mark it ready for review on GitHub', ...(action ? { action } : {}) });
  }
  const review = reviewReason(pr, offers);
  if (review) reasons.push(review);
  const checks = checksReason(pr, offers, autofix);
  if (checks) reasons.push(checks);
  const conflicts = conflictsReason(pr, mergeCheck, now, autofix);
  if (conflicts) reasons.push(conflicts);
  if (pr.mergeBlock === 'behind') {
    reasons.push({
      kind: 'behind',
      state: 'warn',
      label: `Behind ${pr.baseRef ?? 'its base'}`,
      detail: 'the branch is out of date',
      ...(offers.rebaseAvailable ? { action: { act: 'rebase-on-base', label: 'Rebase on base' } satisfies ReasonAction } : {}),
    });
  }
  const refused = pr.mergeBlock === 'blocked' || pr.mergeBlock === 'dirty';
  if (refused && !reasons.some((r) => isBad(r) || r.state === 'run')) {
    const action = openPr(pr);
    reasons.push({ kind: 'github-rule', state: 'bad', label: 'Blocked by a GitHub rule', detail: FALLBACK_DETAIL, ...(action ? { action } : {}) });
  }

  if (pr.canMerge && pr.mergeBlock !== 'clean') {
    // GitHub did not say "clean" (it answered unknown, unstable or has_hooks): never claim it, never count it ready.
    return {
      ready: false,
      headline: 'Merge not confirmed',
      facts: `GitHub: ${pr.mergeBlock === 'unknown' ? 'no answer yet' : pr.mergeBlock}`,
      reasons: [],
    };
  }
  if (pr.canMerge) {
    const passed = pr.checks && pr.checks.state === 'passing' ? ` · ${plural(pr.checks.passed, 'check')} passed` : '';
    const approved = pr.reviewDecision === 'APPROVED' ? 'approved' : 'no review required';
    const clean =
      mergeCheck && mergeCheck.state === 'clean'
        ? ` · karst: no conflicts vs ${mergeCheck.baseRef ?? pr.baseRef ?? 'its base'}, checked ${formatAge(mergeCheck.checkedAt, now) || 'earlier'}`
        : '';
    return {
      ready: true,
      headline: 'Ready to merge',
      facts: `${approved}${passed} · GitHub: clean${clean}`,
      reasons: [],
    };
  }
  // ok-state reasons are shown only beside a problem; a lone "Checks passed" explains nothing.
  const problem = reasons.some((r) => isBad(r) || r.state === 'run');
  return {
    ready: false,
    headline: 'Merge blocked',
    facts: '',
    reasons: problem ? reasons : [],
  };
}

/** The Merge button's disabled title: the reasons that block, joined. */
export function blockingReasonsTitle(readiness: PrMergeReadiness): string {
  return readiness.reasons
    .filter((r) => r.state !== 'ok')
    .map((r) => `${r.label}${r.detail ? ` — ${r.detail}` : ''}`)
    .join(' · ');
}

/** How many reasons block (the header count and the chip). */
export function blockingCount(readiness: PrMergeReadiness): number {
  return readiness.reasons.filter((r) => r.state !== 'ok').length;
}
