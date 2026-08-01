import type { GitRunner } from '../integrations/git.js';

/**
 * Refresh a repository's baseline branch from the remote before a ticket's
 * worktree is cut from it (§ scope). Without this, a worktree branches off
 * whatever the local clone last saw — a stale `develop` produces a ticket that
 * starts life behind the team.
 *
 * A pull is an OPTIMIZATION, never a precondition: every failure path returns a
 * legal start point (the local base) plus a reason, so an unreachable remote,
 * a missing `origin`, or a credential prompt with no tty can never stop a ticket
 * from being created. The caller surfaces the reason; it does not act on it.
 *
 * Async `GitRunner`, not `spawnSync`: this hits the network and runs in the
 * extension host, where a synchronous spawn freezes every webview, the hook
 * endpoint, and every other session for the duration.
 */

const REMOTE = 'origin';

/** Longest git prose that may reach a warning line (one line, hard-capped). */
const MAX_REASON = 200;

export interface PullBaseResult {
  /**
   * The ref the worktree should be cut from — always resolvable. `<base>` when
   * the local branch was fast-forwarded (or nothing could be refreshed),
   * `origin/<base>` when only the remote-tracking ref could be updated.
   */
  startPoint: string;
  /** True when the start point reflects the remote as of this call. */
  refreshed: boolean;
  /** Why the refresh did not happen; null when it did (or nothing was asked). */
  reason: string | null;
}

/** First non-empty line of git's output, capped — never unbounded CLI prose. */
function firstLine(...candidates: string[]): string {
  for (const c of candidates) {
    const line = c.split('\n').map((l) => l.trim()).find((l) => l.length > 0);
    if (line) return line.slice(0, MAX_REASON);
  }
  return '';
}

/**
 * Bring `baseRef` up to date in `repoPath` and answer what to branch from.
 *
 * Two attempts, in this order:
 *  1. `git fetch origin <base>:<base>` — fast-forwards the LOCAL branch without
 *     a checkout, so the stored `base_ref` (a plain branch name, which
 *     `mergeCheck` and the diff views both re-derive from) keeps pointing at
 *     fresh commits. git refuses this when `<base>` is checked out, and refuses
 *     a non-fast-forward outright — both are answers, not errors.
 *  2. `git fetch origin <base>` — updates only the remote-tracking ref, so the
 *     worktree branches from `origin/<base>`. Verified with `rev-parse` first:
 *     fetching a remote that has no such branch exits 0 while leaving nothing
 *     to branch from, and `worktree add` would then fail the whole scope.
 */
export async function pullBaseRef(
  git: GitRunner,
  repoPath: string,
  baseRef: string,
): Promise<PullBaseResult> {
  // Nothing to refresh. `git fetch origin :` is not a question worth asking.
  if (baseRef.trim() === '') {
    return { startPoint: baseRef, refreshed: false, reason: null };
  }

  const ff = await git(['fetch', REMOTE, `${baseRef}:${baseRef}`], repoPath);
  if (ff.exitCode === 0) {
    return { startPoint: baseRef, refreshed: true, reason: null };
  }

  const fetched = await git(['fetch', REMOTE, baseRef], repoPath);
  if (fetched.exitCode !== 0) {
    return {
      startPoint: baseRef,
      refreshed: false,
      reason:
        firstLine(fetched.stderr, fetched.stdout, ff.stderr, ff.stdout) ||
        `git fetch exited ${fetched.exitCode}`,
    };
  }

  const remoteRef = `${REMOTE}/${baseRef}`;
  const resolved = await git(['rev-parse', '--verify', '--quiet', `${remoteRef}^{commit}`], repoPath);
  if (resolved.exitCode !== 0 || resolved.stdout.trim() === '') {
    return {
      startPoint: baseRef,
      refreshed: false,
      reason: `${remoteRef} does not resolve after fetch`,
    };
  }

  return { startPoint: remoteRef, refreshed: true, reason: null };
}
