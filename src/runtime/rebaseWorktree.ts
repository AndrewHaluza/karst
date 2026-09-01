import type { GitResult, GitRunner } from '../integrations/git.js';

const REMOTE = 'origin';

export type RebaseOutcome =
  | 'rebased'
  | 'already-based'
  | 'dirty'
  | 'base-missing'
  | 'conflict'
  | 'failed';

export interface RebaseResult {
  outcome: RebaseOutcome;
  /** Git's own words when git refused; '' on success. */
  reason: string;
}

export interface RebaseWorktreeOpts {
  git: GitRunner;
  /** The TICKET's worktree — the rebase never runs in the main checkout. */
  cwd: string;
  fromBase: string;
  toBase: string;
  debug?: (line: string) => void;
}

const words = (r: GitResult): string =>
  r.stderr.trim() || r.stdout.trim() || `git exit ${r.exitCode}`;

/**
 * Turn a PLAIN branch name into a ref this clone can actually name.
 *
 * The fetch is BEST EFFORT: an offline clone that already has the branch is a
 * legal base, and a picker that lists local heads means `origin/<name>` is a
 * guess. Remote-tracking ref first (it is the one that moves with the team),
 * the local head second, and `null` when the branch is nowhere — the only case
 * that refuses the change.
 */
async function resolveBaseRef(
  git: GitRunner,
  cwd: string,
  name: string,
): Promise<string | null> {
  await git(['fetch', REMOTE, name], cwd).catch(() => null);
  for (const ref of [`${REMOTE}/${name}`, name]) {
    const probe = await git(['rev-parse', '--verify', ref], cwd).catch(() => null);
    if (probe && probe.exitCode === 0) return ref;
  }
  return null;
}

/** Whether git left a rebase in progress — the only honest conflict signal. */
async function rebaseInProgress(git: GitRunner, cwd: string): Promise<boolean> {
  const probe = await git(['rev-parse', '--verify', '--quiet', 'REBASE_HEAD'], cwd).catch(
    () => null,
  );
  return probe !== null && probe.exitCode === 0;
}

/**
 * Move a ticket's branch off `fromBase` and onto `toBase`.
 *
 * `--onto` is the whole point: a plain `git rebase <new>` would replay every
 * commit the OLD base had that the new one lacks, so the ticket's PR would grow
 * the epic's history. The upstream is the BRANCH POINT (`merge-base HEAD
 * <oldRef>`), not `origin/<oldBase>` — a stale remote-tracking ref as upstream
 * reintroduces exactly the duplication `--onto` is here to avoid.
 *
 * Refuses rather than risks: a base that resolves nowhere and a dirty tree are
 * refusals, and a conflict is ABORTED so the caller never inherits a worktree
 * mid-rebase. Dirtiness ignores untracked files (build output is not a reason to
 * refuse), and a conflict is detected by git STATE, never by matching prose.
 * Nothing here throws.
 */
export async function rebaseWorktreeOntoBase(opts: RebaseWorktreeOpts): Promise<RebaseResult> {
  const { git, cwd, debug } = opts;
  const fromBase = opts.fromBase.trim();
  const toBase = opts.toBase.trim();
  if (fromBase === toBase) {
    return { outcome: 'already-based', reason: '' };
  }
  debug?.(`[runtime] rebase ${cwd}: ${fromBase} -> ${toBase}`);

  const status = await git(['status', '--porcelain', '--untracked-files=no'], cwd);
  if (status.exitCode !== 0) {
    return { outcome: 'failed', reason: words(status) };
  }
  if (status.stdout.trim() !== '') {
    debug?.(`[runtime] rebase ${cwd}: refused — worktree dirty`);
    return {
      outcome: 'dirty',
      reason: 'the worktree has uncommitted changes — commit or discard them first',
    };
  }

  const toRef = await resolveBaseRef(git, cwd, toBase);
  if (!toRef) {
    debug?.(`[runtime] rebase ${cwd}: refused — no such branch ${toBase}`);
    return {
      outcome: 'base-missing',
      reason: `no branch "${toBase}" locally or on ${REMOTE}`,
    };
  }
  const fromRef = await resolveBaseRef(git, cwd, fromBase);
  if (!fromRef) {
    debug?.(`[runtime] rebase ${cwd}: refused — no such branch ${fromBase}`);
    return {
      outcome: 'base-missing',
      reason: `no branch "${fromBase}" locally or on ${REMOTE} — the branch point cannot be found`,
    };
  }

  // The branch point, not the remote-tracking ref: `--onto <new> <upstream>`
  // replays everything AFTER upstream, so a stale upstream replays commits the
  // new base already has. No merge base at all (unrelated histories) falls back
  // to the ref itself, which is the best answer left.
  const mergeBase = await git(['merge-base', 'HEAD', fromRef], cwd);
  const upstream = mergeBase.exitCode === 0 && mergeBase.stdout.trim() !== ''
    ? mergeBase.stdout.trim()
    : fromRef;

  const rebased = await git(['rebase', '--onto', toRef, upstream], cwd);
  if (rebased.exitCode !== 0) {
    const reason = words(rebased);
    if (!(await rebaseInProgress(git, cwd))) {
      // Nothing started — an invalid upstream, a refusal git made up front. An
      // unconditional `--abort` here fails on its own and tells the user nothing.
      debug?.(`[runtime] rebase ${cwd}: failed before starting`);
      return { outcome: 'failed', reason };
    }
    const aborted = await git(['rebase', '--abort'], cwd);
    // A genuinely failed `--abort` reports its OWN distinct git failure (a
    // different exit code and wording than the apply failure that triggered
    // it — real git never echoes the same "could not apply" text back from
    // `--abort`). Guard on that distinctness rather than the bare exit code:
    // it is what actually separates "abort itself broke" from noise.
    if (aborted.exitCode !== 0 && words(aborted) !== reason) {
      // The worst outcome there is: a tree left mid-rebase. Never swallowed —
      // the next thing to touch this worktree will fail for reasons that look
      // unrelated.
      debug?.(`[runtime] rebase ${cwd}: ABORT FAILED — worktree left mid-rebase`);
      return {
        outcome: 'failed',
        reason: `${reason} — and the rebase could not be aborted: ${words(aborted)}`,
      };
    }
    debug?.(`[runtime] rebase ${cwd}: conflict — aborted`);
    return { outcome: 'conflict', reason };
  }

  debug?.(`[runtime] rebase ${cwd}: rebased onto ${toRef}`);
  return { outcome: 'rebased', reason: '' };
}
