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
  setArchiveMethod,
  setArchiveRef,
  listCompactableArchives,
  listArchiveBranches,
  listArchiveRefs,
  listActiveWorktreeBranches,
  type ArchiveRow,
  type CompactableArchive,
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

// ---------------------------------------------------------------------------
// Compact: delete branch, ensure archive ref exists
// ---------------------------------------------------------------------------

export interface CompactResult {
  outcome: 'compacted' | 'skipped';
  reason?: string;
}

/**
 * Compact an archived worktree: if no archive ref exists (clean tree), create a
 * snapshot ref that points to the branch tip; then delete the branch.
 *
 * After compact, `refs/karst/archive/<slug>^` is always the branch tip commit.
 * This invariant is what makes restore possible without the branch.
 */
export async function compactWorktree(
  runner: GitRunner,
  store: Store,
  row: ArchiveRow | CompactableArchive,
): Promise<CompactResult> {
  if (row.method === 'git-ref-compact') {
    return { outcome: 'skipped', reason: 'already compacted' };
  }

  const slug = slugOf(row.path);
  const ref = `refs/karst/archive/${slug}`;

  // Ensure the archive ref exists. For a clean tree (no uncommitted delta),
  // `archiveRef` is empty — create a snapshot commit so restore can find the
  // branch tip via <ref>^.
  if (!row.archiveRef) {
    // Verify the branch still exists before attempting snapshot.
    const branchCheck = await runner(
      ['rev-parse', '--verify', '--quiet', `refs/heads/${row.branch}`],
      row.repo,
    );
    if (branchCheck.exitCode !== 0) {
      return {
        outcome: 'skipped',
        reason: `branch ${row.branch} already gone; nothing to compact`,
      };
    }

    // Create a commit whose parent is the branch tip. The tree is identical
    // (clean worktree), but the ref gives restore a parent to reconstruct from.
    const headSha = (
      await run(runner, row.repo, ['rev-parse', `refs/heads/${row.branch}`])
    ).trim();
    const tree = await run(runner, row.repo, ['rev-parse', `${headSha}^{tree}`]);
    const commit = await run(runner, row.repo, [
      '-c',
      'user.name=karst',
      '-c',
      'user.email=karst@local',
      'commit-tree',
      tree,
      '-p',
      headSha,
      '-m',
      `karst-archive:${slug}`,
    ]);
    await run(runner, row.repo, ['update-ref', ref, commit]);
    // Persist the snapshot ref so restore can find it.
    setArchiveRef(store, row.id, ref);
  }

  // Delete the branch.
  const deleteResult = await runner(
    ['branch', '-D', row.branch],
    row.repo,
  );
  if (deleteResult.exitCode !== 0) {
    return {
      outcome: 'skipped',
      reason: `failed to delete branch ${row.branch}: ${deleteResult.stderr || deleteResult.stdout}`,
    };
  }

  setArchiveMethod(store, row.id, 'git-ref-compact');
  return { outcome: 'compacted' };
}

// ---------------------------------------------------------------------------
// Restore from compact: recreate branch from archive ref, then restore
// ---------------------------------------------------------------------------

/**
 * Restore a worktree that was compacted (branch deleted). Recreates the branch
 * from `archiveRef^` (the parent of the snapshot commit = branch tip), then
 * delegates to the normal restore flow.
 */
export async function restoreFromCompact(
  runner: GitRunner,
  store: Store,
  target: { ticketId: number; path: string },
): Promise<RestoreResult> {
  const row = getArchiveByPath(store, target.ticketId, target.path);
  if (!row) return { outcome: 'skipped', reason: 'no archive record' };
  if (row.method !== 'git-ref-compact') {
    // Not compacted — delegate to the normal restore.
    return restoreWorktree(runner, store, target);
  }

  if (!row.archiveRef) {
    return {
      outcome: 'skipped',
      reason: 'compact archive has no ref; data loss suspected',
    };
  }

  // Verify the archive ref exists.
  const refCheck = await runner(
    ['rev-parse', '--verify', '--quiet', row.archiveRef],
    row.repo,
  );
  if (refCheck.exitCode !== 0) {
    return {
      outcome: 'skipped',
      reason: `archive ref ${row.archiveRef} is gone; delta unrecoverable`,
    };
  }

  // Determine the branch tip: the parent of the archive commit.
  const parent = (
    await run(runner, row.repo, ['rev-parse', `${row.archiveRef}^`])
  ).trim();

  // Recreate the branch from the parent (branch tip).
  const branchCheck = await runner(
    ['rev-parse', '--verify', '--quiet', `refs/heads/${row.branch}`],
    row.repo,
  );
  if (branchCheck.exitCode === 0) {
    // Branch already exists (unexpected after compact, but safe).
  } else {
    await run(runner, row.repo, ['branch', row.branch, parent]);
  }

  // Recreate the worktree on the branch.
  createWorktree(store, {
    ticketId: row.ticketId,
    repoPath: row.repo,
    slug: slugOf(row.path),
    branch: row.branch,
    baseRef: row.baseRef ?? row.branch,
  });

  // Replay uncommitted delta if the archive ref's tree differs from its parent.
  const refTree = (
    await run(runner, row.repo, ['rev-parse', `${row.archiveRef}^{tree}`])
  ).trim();
  const parentTree = (
    await run(runner, row.repo, ['rev-parse', `${parent}^{tree}`])
  ).trim();

  if (refTree !== parentTree) {
    await run(runner, row.path, ['cherry-pick', '-n', row.archiveRef]);
    await run(runner, row.path, ['reset', '-q', 'HEAD']);
  }

  // Clean up.
  await run(runner, row.repo, ['update-ref', '-d', row.archiveRef]);
  clearArchive(store, row.id);
  return { outcome: 'restored' };
}

// ---------------------------------------------------------------------------
// Orphan sweep: delete branches and archive refs with no DB backing
// ---------------------------------------------------------------------------

export interface SweepResult {
  prunedBranches: number;
  prunedArchiveRefs: number;
}

/**
 * Sweep orphan git refs: delete `karst/*` branches and `refs/karst/archive/*`
 * refs that have no corresponding row in `worktrees` or `worktree_archives`.
 *
 * This reclaims branch refs accumulated from prior archives and manual deletions.
 */
export async function sweepOrphanRefs(
  runner: GitRunner,
  store: Store,
): Promise<SweepResult> {
  const result: SweepResult = { prunedBranches: 0, prunedArchiveRefs: 0 };

  // Collect branches that ARE in use.
  const activeBranches = listActiveWorktreeBranches(store);
  const archiveBranches = listArchiveBranches(store);
  const usedBranches = new Set<string>();
  for (const b of activeBranches) usedBranches.add(`${b.repo}:${b.branch}`);
  for (const b of archiveBranches) usedBranches.add(`${b.repo}:${b.branch}`);

  // Collect archive refs that ARE in use.
  const usedArchiveRefs = new Set(listArchiveRefs(store));

  // Find and prune orphan branches via each repo that has archives or worktrees.
  const repos = new Set<string>();
  for (const b of activeBranches) repos.add(b.repo);
  for (const b of archiveBranches) repos.add(b.repo);

  for (const repoPath of repos) {
    const listResult = await runner(
      ['branch', '--list', 'karst/*'],
      repoPath,
    );
    if (listResult.exitCode !== 0) continue;
    const branches = listResult.stdout
      .split('\n')
      .map((l) => l.replace(/^\*?\s+/, '').trim())
      .filter(Boolean);

    for (const branch of branches) {
      if (usedBranches.has(`${repoPath}:${branch}`)) continue;
      const del = await runner(['branch', '-D', branch], repoPath);
      if (del.exitCode === 0) result.prunedBranches += 1;
    }
  }

  // Find and prune orphan archive refs.
  const repoPath0 = [...repos][0];
  if (repoPath0) {
    const listArchResult = await runner(
      ['for-each-ref', '--format=%(refname)', 'refs/karst/archive/'],
      repoPath0,
    );
    if (listArchResult.exitCode === 0) {
      const refs = listArchResult.stdout.split('\n').filter(Boolean);
      for (const ref of refs) {
        if (usedArchiveRefs.has(ref)) continue;
        const del = await runner(['update-ref', '-d', ref], repoPath0);
        if (del.exitCode === 0) result.prunedArchiveRefs += 1;
      }
    }
  }

  return result;
}


