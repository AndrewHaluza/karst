import type { GitRunner } from '../integrations/git.js';
import type { PrDiffContext } from './prDescription.js';

/**
 * The branch material a PR description is written from — collected with the
 * SAME injected GitRunner ship already uses, so it is testable without a real
 * repo and adds no new seam. The point of the caps: a description call must
 * stay bounded even for a huge branch. A PR description that costs 400K tokens
 * because the model went exploring for the diff is the bug this module exists
 * to prevent (869ef1e6x) — the diff is gathered here, once, bounded, and handed
 * to the model so it never has to look.
 */

/** Cap on the unified diff handed to the model. */
export const PR_DIFF_MAX_CHARS = 30_000;
/** Cap on the `--stat` output. */
export const PR_STAT_MAX_CHARS = 10_000;
/** Cap on the one-line commit log. */
export const PR_LOG_MAX_CHARS = 4_000;

function bounded(stdout: string, max: number): { value?: string; truncated?: boolean } {
  // Trailing-whitespace trim only: `git diff --stat` lines lead with a space,
  // and unified-diff context lines start with a space that IS the marker —
  // a leading trim would silently corrupt the material handed to the model.
  const text = stdout.replace(/\s+$/u, '');
  if (text === '') return {};
  if (text.length <= max) return { value: text };
  return { value: text.slice(0, max), truncated: true };
}

async function read(
  git: GitRunner,
  args: string[],
  cwd: string,
  max: number,
): Promise<{ value?: string; truncated?: boolean }> {
  const result = await git(args, cwd);
  if (result.exitCode !== 0) return {};
  return bounded(result.stdout, max);
}

/**
 * Read the branch's commits, diffstat, and unified diff against
 * `origin/<base>...HEAD` — the same range `gh pr create` will show. Every piece
 * degrades independently to absent: a failed read must never fail ship, and the
 * prompt simply skips the section (the title still describes the PR).
 */
export async function collectPrDiffContext(
  git: GitRunner,
  cwd: string,
  baseRef: string,
): Promise<PrDiffContext> {
  const range = `origin/${baseRef}...HEAD`;
  const [log, stat, diff] = await Promise.all([
    read(git, ['log', '--oneline', range], cwd, PR_LOG_MAX_CHARS),
    read(git, ['diff', '--stat', range], cwd, PR_STAT_MAX_CHARS),
    read(git, ['diff', '--no-ext-diff', '--unified=3', range], cwd, PR_DIFF_MAX_CHARS),
  ]);
  return {
    ...(log.value !== undefined ? { commits: log.value } : {}),
    ...(stat.value !== undefined ? { diffStat: stat.value } : {}),
    ...(diff.value !== undefined ? { diff: diff.value, ...(diff.truncated ? { diffTruncated: true } : {}) } : {}),
  };
}
