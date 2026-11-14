import type { Store } from '../../store/db.js';
import { GIT_PUSH_TIMEOUT_MS, type GitRunner } from '../../integrations/git.js';

/**
 * The stranded-ship resume rule (@arch:SHIP-RESUME). Host-agnostic helpers: git
 * and the store are injected, nothing here spawns a process of its own.
 */

/** Whether a ship run recorded a `push` step for the repo, in any status. */
export function priorRunHasPushStep(store: Store, shipRunId: number, repo: string): boolean {
  const row = store.db
    .prepare("SELECT 1 AS one FROM ship_repo_steps WHERE ship_run_id = ? AND repo = ? AND step = 'push' LIMIT 1")
    .get(shipRunId, repo);
  return row !== undefined;
}

/**
 * Whether the worktree has no uncommitted file. A status that fails reads as NOT
 * clean: an unreadable worktree must never be delivered by an unattended run.
 */
export async function worktreeIsClean(git: GitRunner, cwd: string): Promise<boolean> {
  const r = await git(['status', '--porcelain', '-uall'], cwd);
  return r.exitCode === 0 && r.stdout.trim() === '';
}

/**
 * How many local commits of HEAD are not on `origin/<ref>`, or null when the
 * count cannot be read (the caller logs it; an unreadable count never parks).
 * The remote-tracking ref is refreshed first, so a push by hand is seen.
 */
export async function commitsNotOnRemote(git: GitRunner, cwd: string, ref: string): Promise<number | null> {
  await git(['fetch', 'origin', `+refs/heads/${ref}:refs/remotes/origin/${ref}`], cwd, {
    timeoutMs: GIT_PUSH_TIMEOUT_MS,
  });
  const r = await git(['rev-list', '--count', `origin/${ref}..HEAD`], cwd);
  if (r.exitCode !== 0) return null;
  const n = Number.parseInt(r.stdout.trim(), 10);
  return Number.isNaN(n) ? null : n;
}

/** The detail of the `push` step a ship records when commits wait and nothing delivered them. */
export function undeliveredCommitsDetail(n: number): string {
  return `${n} local commit(s) not on the PR; click Deliver`;
}
