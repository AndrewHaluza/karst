/**
 * The prompt handed to the session the "Resolve conflicts" button opens.
 *
 * karst runs no git of its own here, deliberately: a button click must not
 * mutate a worktree an agent may still be sitting in, and a half-applied merge
 * left by the extension is a state neither the agent nor the user asked for. So
 * this is context, not action — where, against what, and what the probe saw —
 * and the agent performs the merge itself.
 *
 * A MERGE, never a rebase: the branch is already pushed and a PR points at it,
 * so rewriting its history would demand a force-push under an open review.
 *
 * Pure: no store, no clock, no vscode.
 */

export interface ConflictBriefInput {
  /** Ticket key, or `#<id>` when it has none. */
  ticketLabel: string;
  repo: string;
  worktreePath: string;
  branch: string | null;
  /** The branch the worktree was cut from; null when none was ever recorded. */
  baseRef: string | null;
  /** Conflicting paths as the probe reported them; may be empty. */
  files: readonly string[];
  prUrl: string | null;
}

/** Beyond this the list is prompt bloat — git names them all again at merge time. */
const MAX_LISTED_FILES = 25;

function fileLines(files: readonly string[]): string {
  if (files.length === 0) {
    return 'The probe did not list any paths — the conflict is real (it came from git\'s exit code), so let the merge itself name the files.';
  }
  const shown = files.slice(0, MAX_LISTED_FILES).map((f) => `- ${f}`);
  const rest = files.length - MAX_LISTED_FILES;
  const more = rest > 0 ? [`- +${rest} more`] : [];
  return ['Conflicting paths:', ...shown, ...more].join('\n');
}

export function renderConflictBrief(input: ConflictBriefInput): string {
  const branch = input.branch ? `\`${input.branch}\`` : 'this ticket\'s branch';
  const header = [
    `Ticket ${input.ticketLabel} cannot merge: ${branch} in \`${input.repo}\` conflicts with its base.`,
    `Worktree: ${input.worktreePath}`,
    ...(input.prUrl ? [`Pull request: ${input.prUrl}`] : []),
    '',
    fileLines(input.files),
    '',
  ];

  // No base ref means there is nothing to merge FROM. Naming a guessed branch
  // would send the agent at the wrong history with full confidence.
  if (!input.baseRef) {
    return [
      ...header,
      'No base branch is recorded for this worktree, so the branch to merge from has to be',
      'established first — check the repository entry in `karst.yml` and the PR\'s base on the',
      'forge, confirm it with the user, then merge that branch in and resolve the conflicts.',
      'Do not rebase and do not force-push: the branch is already published under an open PR.',
    ].join('\n');
  }

  return [
    ...header,
    `Resolve it in ${input.worktreePath}:`,
    `1. \`git fetch origin ${input.baseRef}\``,
    `2. \`git merge origin/${input.baseRef}\``,
    '3. Resolve every conflict, keeping BOTH sides\' intent — read the surrounding code before',
    '   choosing; a conflict marker deleted without understanding it is a silent regression.',
    '4. Run the repository\'s build and tests before committing.',
    '5. Commit the merge and push it to the same branch, so the PR picks it up.',
    '',
    'Do not rebase and do not force-push: the branch is already published under an open PR.',
    'If the right resolution is genuinely ambiguous, stop and ask rather than guessing.',
  ].join('\n');
}
