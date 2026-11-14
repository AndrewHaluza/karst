import type { PrView } from '../store/dashboard.js';
import { DAY, formatAge } from './age.js';
import type { MergeBlock } from './prChecks.js';
import { buildPrChecksView, mergeBlockNotice, type PrChecksView } from './prChecksView.js';
import type { MergeCheckRow } from '../store/mergeChecks.js';
import type { PrReviewDecision } from './prReview.js';
import {
  blockingReasonsTitle,
  NO_AUTOFIX,
  NO_OFFERS,
  prMergeReadiness,
  type AutofixInput,
  type PrMergeReadiness,
  type ReadinessOffers,
} from './prMergeReadiness.js';

export { formatAge };

/**
 * How one pull request reads in the ship stage: its metadata already worded, and
 * whether merging is offered.
 *
 * Built host-side for the same reason every other dashboard copy is (the webview
 * is standalone HTML that cannot import a module, so anything it decides for
 * itself is untested and drifts). The webview places these strings; it never
 * formats a date, counts a thread, or decides that a PR is mergeable.
 *
 * Every string is '' rather than a placeholder when the fact is absent — an open
 * PR has no merge stamp, and an unprobed one has no branches. '' renders as
 * nothing; "—" or "unknown" would dress a missing fact as a value.
 */

/** One comment, worded. */
export interface PrCommentRow {
  /** Author login, or '' when gh did not name one. */
  author: string;
  /** Formatted stamp, or '' when there is none to state. */
  when: string;
  body: string;
}

export interface PrPanelRow {
  /** The repository path — the row's IDENTITY, what a merge message names. */
  repo: string;
  /**
   * The repository as DISPLAYED: its manifest NAME when one resolves (the
   * runtime tables key by path), else the worktree path-display preference.
   */
  repoDisplay: string;
  number: number | null;
  url: string | null;
  /** The PR status vocabulary ('open' | 'draft' | 'closed' | 'merged' | 'unknown'). */
  status: string;
  /** `head → base`, one side alone when only one is known, '' when neither is. */
  branches: string;
  /**
   * The target branch alone, or null. Carried beside `branches` because the merge
   * confirmation names what the PR merges INTO, and re-parsing it out of the
   * rendered arrow string would be a second source for the same fact.
   */
  baseRef: string | null;
  /** `opened <relative|date>`, or '' — the adaptive display (formatAge buckets). */
  opened: string;
  /** The full `opened <locale stamp>`, for the row's tooltip; '' when absent. */
  openedTitle: string;
  /** `merged <relative|date>`, or '' — an unmerged PR has no merge stamp. */
  merged: string;
  /** The full `merged <locale stamp>`, for the row's tooltip; '' when absent. */
  mergedTitle: string;
  /** `3 comments`, correctly singular, or '' when the thread is empty. */
  commentsLabel: string;
  comments: PrCommentRow[];
  /** The CI rollup, already worded. Every string '' when there is none. */
  checks: PrChecksView;
  /** `blocked` / `conflicts`, or '' when GitHub is not refusing. */
  mergeBlockLabel: string;
  /** Whether the merge action is offered for this PR. */
  canMerge: boolean;
  /** Why it is not offered — shown on the disabled control; '' when it is. */
  mergeBlockedReason: string;
  /** The PR title from GitHub, or '' when never stated. */
  title: string;
  /** The author login, or '' when never stated. */
  author: string;
  /** `+a −d · f files · c commits` facts, or null when GitHub never stated them. */
  changes: { additions: number; deletions: number; files: number; commits: number } | null;
  /** The review facts. `required` is null: karst does not fetch it. */
  review: { decision: PrReviewDecision; approvals: number; required: number | null; requested: string[] };
  /** Why the PR can or cannot merge, one reason per cause (`model/prMergeReadiness.ts`). */
  readiness: PrMergeReadiness;
  /**
   * Whether a human has declared this PR will never land, so the merge gate
   * stops waiting on it (v56).
   */
  dismissed: boolean;
  /** `dismissed <stamp>` for a dismissed PR, '' otherwise. */
  dismissedLabel: string;
  /**
   * Whether the dismiss action is offered. A merged PR landed and a dismissed
   * one already carries the acknowledgement, so neither is offered it; the undo
   * (`dismissed === true`) is what the panel shows instead.
   */
  canDismiss: boolean;
}

/**
 * A stamp as a person reads it, in their own locale — date AND time, because
 * "when was this opened / merged" is often answered in hours, not days.
 *
 * '' for absent, empty, or unparseable input: the panel shows nothing rather than
 * the string "Invalid Date", which is what `toLocaleString` produces for garbage.
 */
export function formatPrStamp(at: string | null | undefined): string {
  if (typeof at !== 'string' || at === '') return '';
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString();
}

/** `head → base`, degrading to whichever side is known. */
function branchLine(headRef: string | null, baseRef: string | null): string {
  if (headRef && baseRef) return `${headRef} → ${baseRef}`;
  if (headRef) return headRef;
  return baseRef ? `→ ${baseRef}` : '';
}

/**
 * Whether merging is offered, and if not, why.
 *
 * Only a PR karst can currently read as OPEN is offered. The three refusals are
 * all cases where firing the merge would either be refused by gh anyway (draft,
 * closed) or would act on a state karst cannot see (unknown) — and the action is
 * irreversible, so an unreadable state is a reason to stop, not to try.
 *
 * A local merge-conflict check is deliberately NOT a refusal: it is a probe of two
 * moving refs, it can be stale, and GitHub is the authority on whether the merge
 * is allowed. The check is shown beside the PR; it does not veto the button.
 *
 * GitHub's OWN answer (`mergeStateStatus`, normalized to `mergeBlock`) is a
 * different matter and MAY veto: it is the authority stating it will refuse, not
 * a guess about two moving refs. 'unknown' is its lazily computed non-answer and
 * never blocks — a freshly opened PR really does answer UNKNOWN.
 */
function mergability(
  status: string,
  url: string | null,
  mergeBlock: MergeBlock,
): { canMerge: boolean; reason: string } {
  if (!url) return { canMerge: false, reason: 'No pull request url is recorded to merge.' };
  switch (status) {
    case 'open': {
      // GitHub's OWN answer may veto, unlike the local merge-tree probe below —
      // that one is a guess about two moving refs, this one is the authority
      // stating it will refuse. 'unknown' is its lazily computed non-answer and
      // never blocks (a freshly opened PR really does answer UNKNOWN).
      const notice = mergeBlockNotice(mergeBlock);
      return notice.blocks
        ? { canMerge: false, reason: notice.reason }
        : { canMerge: true, reason: '' };
    }
    case 'merged':
      // Nothing to say: the state itself is the explanation, and it is already
      // rendered as the row's status.
      return { canMerge: false, reason: '' };
    case 'draft':
      return { canMerge: false, reason: 'This pull request is still a draft — mark it ready first.' };
    case 'closed':
      return { canMerge: false, reason: 'This pull request is closed — reopen it before merging.' };
    default:
      return {
        canMerge: false,
        reason: 'karst cannot read this pull request’s state, so it will not offer to merge it.',
      };
  }
}

/** Fresh is relative; beyond a week a stamp becomes an absolute date. */
const WEEK = 7 * DAY;

/** One PR stamp as it reads on the row. */
interface StampView {
  /**
   * The compact display label: relative while fresh (`2h ago`), an absolute
   * date once a week has passed. '' when there is no readable stamp at all.
   */
  label: string;
  /** The full locale stamp, for the tooltip. '' exactly when `label` is ''. */
  title: string;
}

/**
 * A stamp's display: relative while fresh, an absolute date past a week, with
 * the full locale stamp preserved for the tooltip — the same adaptive pattern
 * as the merge-verdict line's `4m ago` headline + `checked <stamp>` tooltip,
 * so one panel uses one age vocabulary.
 */
function stampView(at: string | null, now: string): StampView {
  const title = formatPrStamp(at);
  if (!title) return { label: '', title: '' };
  const ms = Date.parse(now) - Date.parse(at!);
  const fresh = Number.isFinite(ms) && ms >= 0 && ms < WEEK;
  return {
    label: fresh ? formatAge(at!, now) : new Date(at!).toLocaleDateString(),
    title,
  };
}

/** What the readiness reasons read beyond the PR itself: karst's merge checks, the offered actions and Autopilot. */
export interface PrReadinessContext {
  readonly mergeChecks: readonly MergeCheckRow[];
  readonly offers: ReadinessOffers;
  readonly autofix: AutofixInput;
  /** Commits the ticket holds that its PRs lack (the undelivered tracker); absent = 0. */
  readonly unpushed?: number;
}

const NO_READINESS_CONTEXT: PrReadinessContext = { mergeChecks: [], offers: NO_OFFERS, autofix: NO_AUTOFIX };

function changesOf(pr: PrView): PrPanelRow['changes'] {
  const { additions, deletions, changedFiles, commitCount } = pr;
  if (additions === null && deletions === null && changedFiles === null && commitCount === null) return null;
  return { additions: additions ?? 0, deletions: deletions ?? 0, files: changedFiles ?? 0, commits: commitCount ?? 0 };
}

/** One panel row per PR, in the order given. `now` is injected (no clock here). */
export function buildPrPanelRows(
  prs: readonly PrView[],
  now: string,
  /**
   * Resolve a recorded repo value (keyed by path in the runtime tables) to its
   * manifest NAME, exactly like the inside ship rows. Absent → the display
   * path stands.
   */
  repoNameFor?: (repo: string) => string | undefined,
  context: PrReadinessContext = NO_READINESS_CONTEXT,
): PrPanelRow[] {
  return prs.map((pr) => {
    const status = pr.status ?? 'unknown';
    const { canMerge, reason } = mergability(status, pr.url, pr.mergeBlock);
    const dismissed = pr.dismissedAt !== null;
    const dismissedStamp = formatPrStamp(pr.dismissedAt);
    const opened = stampView(pr.createdAt, now);
    const merged = stampView(pr.mergedAt, now);
    const count = pr.comments.length;
    const readiness = prMergeReadiness(
      {
        repo: pr.repo,
        url: pr.url,
        status,
        baseRef: pr.baseRef,
        canMerge,
        mergeBlock: pr.mergeBlock,
        checks: pr.checks,
        reviewDecision: pr.reviewDecision,
        approvals: pr.approvals,
        requiredApprovals: null,
        reviewRequests: pr.reviewRequests,
        unpushed: context.unpushed ?? 0,
      },
      context.mergeChecks.find((m) => m.repo === pr.repo),
      context.offers,
      context.autofix,
      now,
    );
    const blocking = blockingReasonsTitle(readiness);
    return {
      repo: pr.repo,
      repoDisplay: repoNameFor?.(pr.repo) ?? (pr.repoDisplay || pr.repo),
      number: pr.number,
      url: pr.url,
      status,
      branches: branchLine(pr.headRef, pr.baseRef),
      baseRef: pr.baseRef,
      opened: opened.label ? `opened ${opened.label}` : '',
      openedTitle: opened.title ? `opened ${opened.title}` : '',
      merged: merged.label ? `merged ${merged.label}` : '',
      mergedTitle: merged.title ? `merged ${merged.title}` : '',
      commentsLabel: count === 0 ? '' : `${count} ${count === 1 ? 'comment' : 'comments'}`,
      comments: pr.comments.map((c) => ({
        author: c.author,
        when: formatPrStamp(c.at),
        body: c.body,
      })),
      checks: buildPrChecksView(pr.checks),
      mergeBlockLabel: mergeBlockNotice(pr.mergeBlock).label,
      canMerge,
      mergeBlockedReason: blocking || reason,
      title: pr.title ?? '',
      author: pr.author ?? '',
      changes: changesOf(pr),
      review: { decision: pr.reviewDecision, approvals: pr.approvals ?? 0, required: null, requested: [...pr.reviewRequests] },
      readiness,
      dismissed,
      dismissedLabel: dismissedStamp ? `dismissed ${dismissedStamp}` : dismissed ? 'dismissed' : '',
      // Offered for anything that has not landed and has not already been
      // acknowledged — including an 'open' PR, because the user closing it on
      // GitHub and dismissing it here are one decision, and karst must not
      // require a specific order for the two halves.
      canDismiss: !dismissed && status !== 'merged',
    };
  });
}
