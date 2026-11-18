import type { ChecksState, FailingCheck, MergeBlock, PrChecks, PrChecksSnapshot } from './prChecks.js';

/**
 * The CI rollup and GitHub's merge refusal, already worded for the PR row.
 *
 * Built host-side for the same reason `prPanelView.ts` and `mergeCheckPanel.ts`
 * are (the webview is standalone HTML that cannot import a module, so anything it
 * words for itself is untested and drifts). The webview places these strings; it
 * never counts a check or decides that a merge is blocked.
 *
 * Pure — no store, no clock, no vscode.
 */

export interface PrChecksView {
  /** Drives the chip's class. 'none' when there is nothing to show at all. */
  state: ChecksState;
  /** `1 failing · 2 passed`, or '' when nothing is worth a chip. */
  label: string;
  /** The chip's tooltip — the full counts. '' exactly when `label` is. */
  title: string;
  /** The disclosure's summary, or '' when there is nothing to open. */
  detailsLabel: string;
  /** The failures, for the disclosure body. Empty unless failing. */
  failing: readonly FailingCheck[];
  /** True when the chip shows the last known counts of an earlier commit. Display only. */
  stale: boolean;
  /** `checking new commit…` for a stale chip, else ''. */
  cue: string;
}

/** A snapshot older than this (counted from the push that cleared the rollup) is not shown: a repo that dropped its CI must not show old counts for ever. */
export const STALE_CHECKS_MAX_AGE_MS = 30 * 60 * 1000;
export const STALE_CHECKS_CUE = 'checking new commit…';

const SHORT_SHA_LENGTH = 7;

/**
 * The rollup as one line, or a row that states nothing.
 *
 * `null` ("never probed"), an 'unknown' rollup, and 'none' (a PR with no CI at
 * all) all render nothing: the panel states no fact rather than the word
 * "unknown", the same rule `prPanelView.ts` applies to every absent fact.
 */
export function buildPrChecksView(
  checks: PrChecks | null,
  snapshot: PrChecksSnapshot | null = null,
  nowMs = 0,
): PrChecksView {
  const current = currentChecksView(checks);
  if (current.label !== '' || snapshot === null) return current;
  if (nowMs - snapshot.at > STALE_CHECKS_MAX_AGE_MS) return current;
  const last = currentChecksView(snapshot.checks);
  if (last.label === '') return current;
  const sha = snapshot.head ? ` ${snapshot.head.slice(0, SHORT_SHA_LENGTH)}` : '';
  return {
    state: last.state,
    label: last.label,
    title: `${last.title} — from the previous commit${sha}; karst is checking the new commit`,
    detailsLabel: '',
    failing: [],
    stale: true,
    cue: STALE_CHECKS_CUE,
  };
}

function currentChecksView(checks: PrChecks | null): PrChecksView {
  const empty: PrChecksView = {
    state: 'none',
    label: '',
    title: '',
    detailsLabel: '',
    failing: [],
    stale: false,
    cue: '',
  };
  if (checks === null || checks.state === 'unknown' || checks.state === 'none') return empty;

  // Order is failing, pending, passed — worst news first, and counts are never
  // pluralized differently ("1 failing" and "2 failing" both read naturally).
  const parts: string[] = [];
  if (checks.failed > 0) parts.push(`${checks.failed} failing`);
  if (checks.pending > 0) parts.push(`${checks.pending} pending`);
  if (checks.passed > 0) parts.push(`${checks.passed} passed`);
  const label = parts.join(' · ');
  if (label === '') return empty;

  const plural = checks.total === 1 ? 'check' : 'checks';
  const failing = checks.failed > 0;
  const shown = failing && checks.failedShown < checks.failed ? ` — first ${checks.failedShown} shown` : '';
  return {
    state: checks.state,
    label,
    title: `${checks.total} ${plural}: ${checks.passed} passed, ${checks.failed} failed, ${checks.pending} pending`,
    detailsLabel: failing ? `${checks.failed} failing ${checks.failed === 1 ? 'check' : 'checks'}${shown}` : '',
    failing: failing ? checks.failing : [],
    stale: false,
    cue: '',
  };
}

/**
 * Whether GitHub's own verdict refuses the merge, and how to say so.
 *
 * Only `blocked` and `dirty` refuse. `BEHIND` does NOT: an out-of-date head can
 * still be merged unless the repository requires branches to be up to date, and
 * `mergeStateStatus` does not say whether it does — vetoing would disable Merge
 * on a merge GitHub would accept, with no way back short of a manual update.
 * `unstable` means only NON-required checks are failing, so GitHub merges that
 * too. `draft` is refused by the PR's own status branch in `mergability`, so
 * printing a second reason here would state it twice.
 */
export function mergeBlockNotice(block: MergeBlock): {
  blocks: boolean;
  label: string;
  reason: string;
} {
  switch (block) {
    case 'blocked':
      return {
        blocks: true,
        label: 'blocked',
        reason: 'GitHub is blocking this merge — a required review or check has not passed.',
      };
    case 'dirty':
      return {
        blocks: true,
        label: 'conflicts',
        reason: 'GitHub reports conflicts on this branch — they must be resolved before it can merge.',
      };
    default:
      return { blocks: false, label: '', reason: '' };
  }
}
