/**
 * Build a throwaway commit from the live worktree so a gate lane can read
 * committed and uncommitted work as one range. It never calls
 * `compareAndSwapHeadAndIndex`, so the branch, HEAD and index are never
 * written; the ref is local and never pushed.
 */
import { createHash } from 'node:crypto';
import {
  prepareCommitInQuarantine,
  promoteQuarantinedObjects,
  cleanupQuarantine,
  type GitRunner,
  type PersistedCommitIdentity,
} from '../integrations/git.js';
import { canonicalPath } from '../runtime/pathScope.js';

export const SNAPSHOT_REF_PREFIX = 'refs/karst/snapshot';

export function snapshotRepoKey(repoPath: string): string {
  return createHash('sha256').update(canonicalPath(repoPath)).digest('hex').slice(0, 16);
}

export function snapshotRefName(ticketId: number, repoPath: string): string {
  return `${SNAPSHOT_REF_PREFIX}/${ticketId}/${snapshotRepoKey(repoPath)}`;
}

export interface CreateReviewSnapshotOpts {
  /** The ticket the snapshot belongs to — part of the ref name. */
  ticketId: number;
  /** The repository path the worktree row carries; hashed into the ref name. */
  repoPath: string;
  /** The worktree root. Every git command runs here. */
  worktreePath: string;
  /** Verbose decision-point logging, prefixed `[gate]`. */
  debug?: (message: string) => void;
  /** Injected clock for the commit identity timestamp. */
  now?: () => string;
}

export async function createReviewSnapshot(
  git: GitRunner,
  opts: CreateReviewSnapshotOpts,
): Promise<string | null> {
  const ref = snapshotRefName(opts.ticketId, opts.repoPath);
  const key = `snapshot-${opts.ticketId}-${snapshotRepoKey(opts.repoPath)}`;
  try {
    const head = await git(['rev-parse', 'HEAD'], opts.worktreePath);
    if (head.exitCode !== 0 || head.stdout.trim() === '') {
      opts.debug?.(`[gate] snapshot ${ref}: no resolvable HEAD — falling back to the branch range`);
      return null;
    }

    const nameR = await git(['config', 'user.name'], opts.worktreePath);
    const emailR = await git(['config', 'user.email'], opts.worktreePath);
    const at = (opts.now ?? (() => new Date().toISOString()))();
    const identity: PersistedCommitIdentity = {
      name: nameR.exitCode === 0 && nameR.stdout.trim() ? nameR.stdout.trim() : 'karst',
      email: emailR.exitCode === 0 && emailR.stdout.trim() ? emailR.stdout.trim() : 'karst@local',
      at,
    };

    try {
      const prepared = await prepareCommitInQuarantine(git, opts.worktreePath, key, {
        preHead: head.stdout.trim(),
        message: `karst review snapshot for ticket ${opts.ticketId}`,
        author: identity,
        committer: identity,
      });
      await promoteQuarantinedObjects(git, opts.worktreePath, key);
      const update = await git(['update-ref', ref, prepared.expectedHead], opts.worktreePath);
      if (update.exitCode !== 0) {
        opts.debug?.(`[gate] snapshot ${ref}: update-ref failed — falling back to the branch range`);
        return null;
      }
      opts.debug?.(`[gate] snapshot ${ref}: created at ${prepared.expectedHead.slice(0, 7)}`);
      return ref;
    } finally {
      await cleanupQuarantine(git, opts.worktreePath, key).catch(() => {});
    }
  } catch (error) {
    opts.debug?.(
      `[gate] snapshot ${ref}: failed (${error instanceof Error ? error.message : String(error)}) — falling back to the branch range`,
    );
    return null;
  }
}

export async function deleteReviewSnapshot(
  git: GitRunner,
  opts: { ticketId: number; repoPath: string; worktreePath: string; debug?: (m: string) => void },
): Promise<void> {
  const ref = snapshotRefName(opts.ticketId, opts.repoPath);
  try {
    const r = await git(['update-ref', '-d', ref], opts.worktreePath);
    if (r.exitCode !== 0) opts.debug?.(`[gate] snapshot ${ref}: delete failed (exit ${r.exitCode})`);
    else opts.debug?.(`[gate] snapshot ${ref}: deleted`);
  } catch (error) {
    opts.debug?.(
      `[gate] snapshot ${ref}: delete threw (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}
