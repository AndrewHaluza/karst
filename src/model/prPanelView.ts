import type { PrView } from '../store/dashboard.js';

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
  /** The repository as DISPLAYED, per the worktree path-display preference. */
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
  /** `opened <stamp>`, or ''. */
  opened: string;
  /** `merged <stamp>`, or '' — an unmerged PR has no merge stamp, by definition. */
  merged: string;
  /** `3 comments`, correctly singular, or '' when the thread is empty. */
  commentsLabel: string;
  comments: PrCommentRow[];
  /** Whether the merge action is offered for this PR. */
  canMerge: boolean;
  /** Why it is not offered — shown on the disabled control; '' when it is. */
  mergeBlockedReason: string;
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
 */
function mergability(status: string, url: string | null): { canMerge: boolean; reason: string } {
  if (!url) return { canMerge: false, reason: 'No pull request url is recorded to merge.' };
  switch (status) {
    case 'open':
      return { canMerge: true, reason: '' };
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

/** One panel row per PR, in the order given. */
export function buildPrPanelRows(prs: readonly PrView[]): PrPanelRow[] {
  return prs.map((pr) => {
    const status = pr.status ?? 'unknown';
    const { canMerge, reason } = mergability(status, pr.url);
    const openedAt = formatPrStamp(pr.createdAt);
    const mergedAt = formatPrStamp(pr.mergedAt);
    const count = pr.comments.length;
    return {
      repo: pr.repo,
      repoDisplay: pr.repoDisplay || pr.repo,
      number: pr.number,
      url: pr.url,
      status,
      branches: branchLine(pr.headRef, pr.baseRef),
      baseRef: pr.baseRef,
      opened: openedAt ? `opened ${openedAt}` : '',
      merged: mergedAt ? `merged ${mergedAt}` : '',
      commentsLabel: count === 0 ? '' : `${count} ${count === 1 ? 'comment' : 'comments'}`,
      comments: pr.comments.map((c) => ({
        author: c.author,
        when: formatPrStamp(c.at),
        body: c.body,
      })),
      canMerge,
      mergeBlockedReason: reason,
    };
  });
}
