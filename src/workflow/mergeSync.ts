import type { Store } from '../store/db.js';
import type { ProjectScope } from '../store/tickets.js';
import { listSyncablePrs } from '../store/prs.js';
import { getMergeCheck, setMergeCheck } from '../store/mergeChecks.js';
import { checkMergeable } from './mergeCheck.js';
import { defaultGitRunner, type GitRunner } from '../integrations/git.js';
import { nowIso } from '../model/time.js';

/**
 * Keep every open PR's mergeability current, long after the ship that opened it.
 *
 * Ship probes once and moves on, so its verdict describes the base as it stood
 * that minute. The base then keeps moving — that is the whole failure this
 * exists for: a PR that was clean at ship time becomes unmergeable while the
 * ticket reads `done`, and a human finds out at merge time with the session that
 * had the context long gone.
 *
 * Same shape as `prSync` and deliberately so: host-agnostic, pure over the
 * injected runner, returns how many verdicts MOVED so the caller can skip a
 * dashboard refresh when nothing did.
 *
 * Overwrites rather than preserving the last good answer (the opposite of
 * `prSync`'s degradation rule) because `merge_checks` is current state, not
 * evidence: an `unknown` carrying git's own words is an honest non-answer, while
 * a retained `clean` from an hour ago is a wrong answer stated with confidence.
 */
export interface MergeSyncOptions {
  scope?: ProjectScope;
  /**
   * Leave a repo unprobed while its stored verdict is younger than this. The
   * sweep rides the 60s PR tick and every probe costs a `git fetch`; without a
   * floor a five-repo project fetches five times a minute forever.
   */
  minAgeMs?: number;
  /**
   * The base branch to measure against, per repo. The manifest baseline is the
   * authority ship itself uses; absent (or null for a repo) this falls back to
   * the branch recorded on the worktree row.
   */
  baseRefFor?: (repo: string) => string | null;
  /** Injected clock, so the age floor is testable without faking time. */
  now?: () => string;
}

/**
 * Whether a stored verdict is still fresh enough to trust without re-probing.
 * An unparseable timestamp is treated as no timestamp — an unreadable age must
 * not freeze a repo out of the sweep forever.
 */
function isFresh(checkedAt: string, now: string, minAgeMs: number): boolean {
  if (minAgeMs <= 0) return false;
  const then = Date.parse(checkedAt);
  const at = Date.parse(now);
  if (Number.isNaN(then) || Number.isNaN(at)) return false;
  return at - then < minAgeMs;
}

export async function syncMergeChecks(
  store: Store,
  git: GitRunner = defaultGitRunner,
  opts: MergeSyncOptions = {},
): Promise<number> {
  const now = opts.now ?? nowIso;
  const minAgeMs = opts.minAgeMs ?? 0;
  // `listSyncablePrs` already drops merged PRs and any repo whose worktree is
  // gone — a merged PR cannot move again, and an archived worktree has nowhere
  // to run git.
  const prs = listSyncablePrs(store, opts.scope ?? {});
  let changed = 0;

  for (const pr of prs) {
    try {
      const prior = getMergeCheck(store, pr.ticketId, pr.repo);
      if (prior && isFresh(prior.checkedAt, now(), minAgeMs)) continue;

      const baseRef = opts.baseRefFor?.(pr.repo) ?? pr.baseRef;
      const check = await checkMergeable(git, pr.cwd, baseRef);
      setMergeCheck(store, {
        ...check,
        ticketId: pr.ticketId,
        repo: pr.repo,
        baseRef,
        checkedAt: now(),
      });
      if (!prior || prior.state !== check.state) changed += 1;
    } catch {
      // One repo's store write blowing up must not abort the sweep — the rest
      // still get a current verdict. `checkMergeable` never throws on its own.
      continue;
    }
  }

  return changed;
}
