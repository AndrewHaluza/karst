import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import type { Store } from '../store/db.js';
import type { GitRunner } from '../integrations/git.js';
import type { PortAllocator } from '../resolver/allocator.js';
import { createWorktree, removeWorktree, canonicalPath, type WorktreeRecord } from './worktree.js';
import type { ReapedServer } from './worktreeServers.js';
import {
  recordArchive,
  getArchiveByPath,
  clearArchive,
} from '../store/worktreeArchives.js';

export interface ArchiveTarget {
  ticketId: number;
  repoPath: string;
  path: string;
  branch: string;
  baseRef: string;
}

export interface ArchiveResult {
  outcome: 'archived' | 'skipped';
  reason?: string;
  archiveRef: string;
  /**
   * Servers that were running inside the worktree and had to be dealt with
   * before it could be removed. Carried out so the caller reports them: an
   * archive that silently kills a running dev server — or that silently could
   * not — is the same invisibility this fix exists to end (869ed2n50). Empty on
   * a skip, and empty in the normal case where nothing was running.
   */
  reapedServers: ReapedServer[];
}

export interface RestoreResult {
  outcome: 'restored' | 'skipped';
  reason?: string;
}

/**
 * The ticket's worktree slug, taken from the worktree PATH — never by stripping a
 * `karst/` prefix off the branch. The branch name is templated
 * (`conventions.branchName`) and may carry slashes of its own, which would turn
 * the flat archive ref into a nested one; the path's leaf is the slug by
 * construction (`worktreePaths`). For a legacy `karst/<slug>` branch this yields
 * exactly the old value, so existing archive refs keep resolving.
 */
function slugOf(worktreePath: string): string {
  return basename(worktreePath);
}

/** Run a git command through the injected runner; throw on nonzero exit. Returns trimmed stdout. */
async function run(runner: GitRunner, cwd: string, args: string[]): Promise<string> {
  const r = await runner(args, cwd);
  if (r.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${r.stderr || r.stdout}`);
  }
  return r.stdout.trim();
}

/** True if git has a linked worktree registered at exactly `path` (async — no event-loop block). */
async function isRegistered(runner: GitRunner, repoPath: string, path: string): Promise<boolean> {
  const r = await runner(['worktree', 'list', '--porcelain'], repoPath);
  if (r.exitCode !== 0) return false;
  const want = canonicalPath(path);
  return r.stdout
    .split('\n')
    .some((line) => line.startsWith('worktree ') && canonicalPath(line.slice('worktree '.length)) === want);
}

/**
 * Archive a worktree: capture its uncommitted delta into refs/karst/archive/<slug>
 * (branch untouched — committed work already lives on the branch), then remove the
 * folder + git worktree via removeWorktree, and record a worktree_archives row.
 *
 * The worktree is deleted right after, so staging into its own index is harmless —
 * no throwaway index needed. `.gitignore` keeps node_modules/dist out of capture.
 * An orphan folder (present but unregistered) is skipped, never deleted.
 */
export async function archiveWorktree(
  runner: GitRunner,
  store: Store,
  allocator: PortAllocator,
  target: ArchiveTarget,
): Promise<ArchiveResult> {
  const { ticketId, repoPath, path, branch, baseRef } = target;

  if (!existsSync(path)) {
    return { outcome: 'skipped', reason: 'folder already gone', archiveRef: '', reapedServers: [] };
  }
  if (!(await isRegistered(runner, repoPath, path))) {
    return {
      outcome: 'skipped',
      reason: 'orphan folder (not a registered worktree)',
      archiveRef: '',
      reapedServers: [],
    };
  }

  const slug = slugOf(path);
  const ref = `refs/karst/archive/${slug}`;

  await run(runner, path, ['add', '-A']);
  const tree = await run(runner, path, ['write-tree']);
  const headTree = await run(runner, path, ['rev-parse', 'HEAD^{tree}']);

  let archiveRef = '';
  if (tree !== headTree) {
    const commit = await run(runner, path, [
      '-c',
      'user.name=karst',
      '-c',
      'user.email=karst@local',
      'commit-tree',
      tree,
      '-p',
      'HEAD',
      '-m',
      `karst-archive:${slug}`,
    ]);
    await run(runner, path, ['update-ref', ref, commit]);
    archiveRef = ref;
  }

  const record: WorktreeRecord = {
    ticketId,
    repoPath,
    slug,
    path,
    branch,
    baseRef,
    depsMode: 'inherited',
    adopted: false,
  };
  const reapedServers = removeWorktree(store, record, allocator);

  recordArchive(store, {
    ticketId,
    repo: repoPath,
    path,
    branch,
    baseRef,
    archiveRef,
    method: 'git-ref',
  });

  return { outcome: 'archived', archiveRef, reapedServers };
}

/**
 * Restore an archived worktree: recreate the git worktree from its surviving
 * branch at the original path, replay the uncommitted delta as unstaged edits,
 * then drop the ref + clear the row. If the branch is gone, skip loudly and keep
 * the ref so the delta stays recoverable — never recreate from base (that would
 * lose committed work).
 */
export async function restoreWorktree(
  runner: GitRunner,
  store: Store,
  target: { ticketId: number; path: string },
): Promise<RestoreResult> {
  const row = getArchiveByPath(store, target.ticketId, target.path);
  if (!row) return { outcome: 'skipped', reason: 'no archive record' };

  const branchExists = await runner(
    ['rev-parse', '--verify', '--quiet', `refs/heads/${row.branch}`],
    row.repo,
  );
  if (branchExists.exitCode !== 0) {
    return {
      outcome: 'skipped',
      reason: `branch ${row.branch} is gone; uncommitted delta preserved at ${row.archiveRef || '(none)'}`,
    };
  }

  // Recreate on the STORED branch, not one re-derived from a template that may
  // have changed since: the committed work lives on that exact branch.
  createWorktree(store, {
    ticketId: row.ticketId,
    repoPath: row.repo,
    slug: slugOf(row.path),
    branch: row.branch,
    baseRef: row.baseRef ?? row.branch,
  });

  if (row.archiveRef) {
    // cherry-pick -n applies parent->commit (== the uncommitted delta, since the
    // archive commit's parent is the branch tip) into worktree + index; reset
    // unstages it and clears CHERRY_PICK_HEAD.
    await run(runner, row.path, ['cherry-pick', '-n', row.archiveRef]);
    await run(runner, row.path, ['reset', '-q', 'HEAD']);
    await run(runner, row.repo, ['update-ref', '-d', row.archiveRef]);
  }

  clearArchive(store, row.id);
  return { outcome: 'restored' };
}
