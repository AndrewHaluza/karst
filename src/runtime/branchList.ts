import type { GitRunner, GitRunOptions } from '../integrations/git.js';

const REMOTE_PREFIX = 'origin/';

/**
 * The branches a ticket may be based on, for a picker. Local heads AND
 * `origin/*` — an epic branch usually exists only on the remote in a fresh
 * clone — reduced to PLAIN names, because that is what `worktrees.base_ref`
 * stores and what every consumer re-prefixes itself.
 *
 * Never throws: a picker that cannot list branches still has to render, and the
 * field stays free-text so an unlisted branch is always reachable.
 */
export async function listBaseBranchCandidates(
  git: GitRunner,
  repoPath: string,
  opts: GitRunOptions = {},
): Promise<string[]> {
  const result = await git(
    ['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes/origin'],
    repoPath,
    opts,
  ).catch(() => null);
  if (!result || result.exitCode !== 0) return [];

  const names = new Set<string>();
  for (const line of result.stdout.split('\n')) {
    const raw = line.trim();
    if (raw === '') continue;
    const name = raw.startsWith(REMOTE_PREFIX) ? raw.slice(REMOTE_PREFIX.length) : raw;
    if (name === '' || name === 'HEAD') continue;
    names.add(name);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}
