/**
 * Pure helpers for the Tester's "observed nothing" result (arch:UAT-OBS): a
 * target whose coverage is SKIPPED / NOT RUN and that kept no observation. No
 * store, no adapter — `tester.ts` owns the run, this owns the words.
 */
import { coverageStatus, skipReason, MAX_SKIP_DETAIL } from '../../model/coverageRecord.js';

export type OnSkip = 'pass' | 'reask' | 'reask-then-park';

/** SKIPPED / NOT RUN coverage and not one observation: the target checked nothing. */
export function observedNothing(coverageTitle: string, observations: number): boolean {
  if (observations > 0) return false;
  const status = coverageStatus(coverageTitle);
  return status === 'SKIPPED' || status === 'NOT RUN';
}

/** The skipped run's detail: the FIRST skipped target's reason, repo-prefixed when several were asked. */
export function skippedDetail(first: { repo: string; title: string }, targetCount: number): string {
  const reason = skipReason(first.title);
  const text = targetCount > 1 ? `${first.repo}: ${reason}` : reason;
  return text.length > MAX_SKIP_DETAIL ? `${text.slice(0, MAX_SKIP_DETAIL - 1)}…` : text;
}

/** The exact text prepended to the Tester prompt on the one re-ask (`onSkip` reask / reask-then-park). */
export function reaskPrefix(coverageTitle: string): string {
  const quoted = coverageTitle.replace(/\s+/g, ' ').trim();
  const title = quoted.length > MAX_SKIP_DETAIL ? `${quoted.slice(0, MAX_SKIP_DETAIL - 1)}…` : quoted;
  return (
    `Your previous UAT run on this ticket observed nothing. You reported: "${title}".\n` +
    'Before you report SKIPPED again, try to exercise the change another way: use the probe, or run the changed code from source with `npx tsx` (a CLI verb or a short script that imports the changed module). Do not install packages and do not run a test runner. Report SKIPPED again only if that also cannot exercise the change, and name the command you ran and its result.'
  );
}
