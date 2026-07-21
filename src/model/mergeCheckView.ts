import type { MergeState } from '../workflow/mergeCheck.js';

/**
 * Presentation of a merge check, shared by the dashboard strip and the rendered
 * ticket context (which the `karst context` CLI prints verbatim).
 *
 * Shared on purpose: the two surfaces must not drift into describing the same
 * three-valued fact differently — an agent reading "unknown" from the CLI and a
 * human reading "clean" from the panel would be looking at the same row.
 *
 * Pure: no store, no clock, no vscode.
 */

export interface MergeCheckView {
  state: MergeState;
  files: readonly string[];
  reason: string | null;
}

/** Beyond this, the list stops being readable and the DB is the place to look. */
const MAX_LISTED_FILES = 5;

function fileList(files: readonly string[]): string {
  if (files.length === 0) return '';
  const shown = files.slice(0, MAX_LISTED_FILES).join(', ');
  const rest = files.length - MAX_LISTED_FILES;
  return rest > 0 ? `${shown} (+${rest} more)` : shown;
}

/**
 * One line describing the check.
 *
 * `unknown` always carries git's own words rather than a paraphrase, so the
 * reader can search for the message, and is never phrased as reassurance — it is
 * an unanswered question, not a soft pass.
 *
 * A `conflicted` check with no listed files still reads as conflicted. The
 * verdict came from an exit code; only the file list came from parsing output,
 * and a parsing surprise must not soften the verdict.
 */
export function summarizeMergeCheck(check: MergeCheckView): string {
  switch (check.state) {
    case 'clean':
      return 'clean';
    case 'conflicted': {
      const listed = fileList(check.files);
      const count = check.files.length;
      if (count === 0) return 'conflicted';
      return `conflicted (${count} ${count === 1 ? 'file' : 'files'}: ${listed})`;
    }
    case 'unknown':
      return check.reason ? `unknown (${check.reason})` : 'unknown';
  }
}

/**
 * The strip's status dot for a merge check.
 *
 * `unknown` maps to `note`, never to `pass`: `note` exists precisely for a fact
 * karst cannot honestly dress as a verdict, and calling an unanswered check a
 * pass is the failure this whole feature exists to prevent.
 *
 * A `fail` row can appear inside a stage that PASSED. That is correct and
 * deliberate — the ship succeeded (a PR exists); the merge is a separate fact.
 */
export function mergeOpStatus(state: MergeState): 'pass' | 'fail' | 'note' {
  switch (state) {
    case 'clean':
      return 'pass';
    case 'conflicted':
      return 'fail';
    case 'unknown':
      return 'note';
  }
}
