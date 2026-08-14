import type { MergeCheckRow } from '../store/mergeChecks.js';
import type { MergeState } from '../workflow/mergeCheck.js';
import { formatAge, formatPrStamp } from './prPanelView.js';

/**
 * How one repo's mergeability reads on the dashboard PR panel.
 *
 * Built host-side, like every other piece of dashboard copy: the webview is
 * standalone HTML that cannot import a module, so anything it words for itself
 * is untested and drifts.
 *
 * Separate from `mergeCheckView.ts` on purpose. That module's job is keeping the
 * ship strip and the `karst context` CLI from describing one three-valued fact
 * two different ways, and both of those place their string in a genuinely
 * one-line slot. This panel has room for a second line, so it says more — and
 * dashboard-only copy living in the shared module would undercut the very thing
 * that module exists to protect.
 *
 * Pure: no store, no clock, no vscode. `now` is injected.
 */
export interface MergeCheckPanelRow {
  /** The repository path — the row's IDENTITY, what a Resolve click sends back. */
  repo: string;
  /** Drives the dot's shape and colour, and whether Resolve is offered. */
  state: MergeState;
  /**
   * `conflicted · 4 files · vs develop · 4m ago`. Each part is dropped entirely
   * when its fact is absent — never a placeholder, and never git's own prose,
   * which is unbounded and would truncate in a one-line slot.
   */
  headline: string;
  /**
   * The disclosure's summary, or '' when there is nothing to open. '' renders no
   * disclosure at all rather than an empty one.
   */
  detailsLabel: string;
  /** Conflicting paths, verbatim and uncapped. Empty unless conflicted. */
  files: readonly string[];
  /** git's own words. Non-empty only for an `unknown` check that carried one. */
  reason: string;
  /**
   * The absolute stamp, for the headline's tooltip. The relative age is what a
   * reader scans; this is what stays true once the panel has sat open and that
   * relative label has drifted. '' when the stamp could not be read.
   */
  checkedTitle: string;
}

function plural(n: number, noun: string): string {
  return `${n} ${n === 1 ? noun : `${noun}s`}`;
}

/** The disclosure summary — '' whenever there is no body worth opening. */
function detailsLabelFor(state: MergeState, files: readonly string[], reason: string): string {
  if (state === 'conflicted' && files.length > 0) return plural(files.length, 'conflicting file');
  if (state === 'unknown' && reason !== '') return 'why karst could not tell';
  return '';
}

/** One panel row per check, in the order given. */
export function buildMergeCheckPanelRows(
  checks: readonly MergeCheckRow[],
  now: string,
): MergeCheckPanelRow[] {
  return checks.map((check) => {
    // Both are scoped to the state that can carry them, so a row written by a
    // newer karst — or a state that got rewritten to 'unknown' on read — can
    // never surface a stale file list beside a verdict that has no files.
    const files = check.state === 'conflicted' ? check.files : [];
    const reason = check.state === 'unknown' ? (check.reason ?? '') : '';
    const parts = [
      check.state,
      files.length > 0 ? plural(files.length, 'file') : '',
      check.baseRef ? `vs ${check.baseRef}` : '',
      formatAge(check.checkedAt, now),
    ].filter((part) => part !== '');
    return {
      repo: check.repo,
      state: check.state,
      headline: parts.join(' · '),
      detailsLabel: detailsLabelFor(check.state, files, reason),
      files,
      reason,
      checkedTitle: formatPrStamp(check.checkedAt),
    };
  });
}
