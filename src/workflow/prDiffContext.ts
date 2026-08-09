import type { GitRunner } from '../integrations/git.js';
import type { PrDiffContext } from './prDescription.js';

/**
 * The branch material a PR description is written from — collected with the
 * SAME injected GitRunner ship already uses, so it is testable without a real
 * repo and adds no new seam. The caps keep public metadata bounded even for a
 * huge branch. Ship renders these facts locally; it never hands a tool-capable
 * agent a repository path or asks one to discover the changes (869ef1e6x).
 */

/** Cap on the `--stat` output. */
export const PR_STAT_MAX_CHARS = 10_000;
/** Cap on the one-line commit log. */
export const PR_LOG_MAX_CHARS = 4_000;

function bounded(stdout: string, max: number): { value?: string; truncated?: boolean } {
  // Trailing-whitespace trim only: `git diff --stat` lines lead with a space,
  // and a leading trim would silently reshape the public metadata.
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
 * Read the branch's own commits and PR diffstat. Commits use two-dot range so
 * commits unique to a diverged base can never appear in the description; the
 * diffstat uses the PR's merge-base comparison. Every piece degrades
 * independently to absent: a failed read must never fail ship, and the renderer
 * simply skips the section (the title still describes the PR).
 */
export async function collectPrDiffContext(
  git: GitRunner,
  cwd: string,
  baseRef: string,
): Promise<PrDiffContext> {
  const logRange = `origin/${baseRef}..HEAD`;
  const diffRange = `origin/${baseRef}...HEAD`;
  const [log, stat] = await Promise.all([
    read(git, ['log', '--oneline', logRange], cwd, PR_LOG_MAX_CHARS),
    read(git, ['diff', '--stat', diffRange], cwd, PR_STAT_MAX_CHARS),
  ]);
  return {
    ...(log.value !== undefined
      ? { commits: log.value, ...(log.truncated ? { commitsTruncated: true } : {}) }
      : {}),
    ...(stat.value !== undefined
      ? { diffStat: stat.value, ...(stat.truncated ? { diffStatTruncated: true } : {}) }
      : {}),
  };
}
