import type { GitRunner } from '../../integrations/git.js';
import { remoteRefSha } from '../../integrations/git.js';

/** Matches git's rejection of a push that is not a fast-forward of the remote ref. */
const NON_FAST_FORWARD = /non-fast-forward|fetch first|tip of your current branch is behind/i;

export function isNonFastForward(err: unknown): boolean {
  return NON_FAST_FORWARD.test(err instanceof Error ? err.message : String(err));
}

export interface ForeignCommit {
  sha: string;
  subject: string;
}

export type RejectedPushClass =
  /** origin still holds the SHA karst itself last pushed — a lease over it is safe. */
  | { kind: 'own'; originSha: string }
  /** origin carries commits the local HEAD lacks. */
  | { kind: 'foreign'; originSha: string; commits: ForeignCommit[] }
  /** origin could not be read, or holds nothing the push could be blamed on. */
  | { kind: 'unreadable'; originSha: string | null };

/**
 * Fetch `origin/<ref>` and decide what a non-fast-forward rejection means. The
 * returned `originSha` is read from the freshly fetched tracking ref, so a
 * lease built from it is a value karst observed.
 */
export async function classifyRejectedPush(
  git: GitRunner,
  cwd: string,
  ref: string,
  lastPushed: string | null,
): Promise<RejectedPushClass> {
  const fetched = await git(['fetch', 'origin', ref], cwd);
  if (fetched.exitCode !== 0) return { kind: 'unreadable', originSha: null };
  const originSha = await remoteRefSha(git, cwd, 'origin', ref);
  if (originSha === null) return { kind: 'unreadable', originSha: null };
  if (lastPushed !== null && originSha === lastPushed) return { kind: 'own', originSha };
  const log = await git(['log', '--format=%h%x09%s', `HEAD..${originSha}`], cwd);
  if (log.exitCode !== 0) return { kind: 'unreadable', originSha };
  const commits = log.stdout
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => {
      const [sha = '', ...rest] = l.split('\t');
      return { sha, subject: rest.join('\t') };
    });
  return commits.length > 0 ? { kind: 'foreign', originSha, commits } : { kind: 'unreadable', originSha };
}

/** The exact manual recovery, for a failure karst cannot classify. */
export function manualLeaseCommand(ref: string, sha: string | null): string {
  return `git push --force-with-lease=${ref}:${sha ?? '<sha>'} origin HEAD`;
}

/** The `push-diverged` block reason: `<repo>: origin/<ref> is at …`, then one `<sha> <subject>` line per commit. */
export function divergedReason(
  repo: string,
  ref: string,
  originSha: string,
  commits: ForeignCommit[],
): string {
  const lines = commits.map((c) => `${c.sha} ${c.subject}`);
  return [
    `${repo}: origin/${ref} is at ${originSha} with ${commits.length} commit(s) not in the branch:`,
    ...lines,
  ].join('\n');
}
