import { spawnSync } from 'node:child_process';
import type { Store } from '../store/db.js';
import { listCompactableArchives, setArchiveMethod, setArchiveRef } from '../store/worktreeArchives.js';

/** Default: compact archives older than 7 days. */
const DEFAULT_OLDER_THAN_MS = 7 * 24 * 60 * 60 * 1000;

function git(cwd: string, args: string[]): { exitCode: number; stdout: string; stderr: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { exitCode: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function refResolves(cwd: string, ref: string): boolean {
  return git(cwd, ['rev-parse', '--verify', '--quiet', ref]).exitCode === 0;
}

export interface CompactResult {
  compacted: number;
  skipped: number;
  failed: number;
  prunedBranches: number;
  prunedArchiveRefs: number;
}

/**
 * CLI verb `karst compact`: compact archived worktrees and sweep orphan refs.
 * Runs synchronously via node:sqlite + spawnSync (no better-sqlite3 addon).
 */
export function runCompactCommand(store: Store, args: string[]): CompactResult {
  let olderThanMs = DEFAULT_OLDER_THAN_MS;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--older-than-days') {
      olderThanMs = Number(args[++i]) * 24 * 60 * 60 * 1000;
    }
  }

  const candidates = listCompactableArchives(store, olderThanMs);
  const result: CompactResult = { compacted: 0, skipped: 0, failed: 0, prunedBranches: 0, prunedArchiveRefs: 0 };

  for (const c of candidates) {
    try {
      if (c.method === 'git-ref-compact') { result.skipped++; continue; }

      const slug = c.path.split('/').pop()!;
      const ref = `refs/karst/archive/${slug}`;

      // Ensure archive ref exists (create snapshot for clean trees).
      if (!c.archiveRef) {
        const branchCheck = git(c.repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${c.branch}`]);
        if (branchCheck.exitCode !== 0) { result.skipped++; continue; }

        const headSha = git(c.repo, ['rev-parse', `refs/heads/${c.branch}`]).stdout.trim();
        const tree = git(c.repo, ['rev-parse', `${headSha}^{tree}`]).stdout.trim();
        const commit = git(c.repo, [
          '-c', 'user.name=karst', '-c', 'user.email=karst@local',
          'commit-tree', tree, '-p', headSha, '-m', `karst-archive:${slug}`,
        ]).stdout.trim();
        git(c.repo, ['update-ref', ref, commit]);
        setArchiveRef(store, c.id, ref);
      }

      // Delete branch.
      const del = git(c.repo, ['branch', '-D', c.branch]);
      if (del.exitCode !== 0) { result.failed++; continue; }

      setArchiveMethod(store, c.id, 'git-ref-compact');
      result.compacted++;
    } catch {
      result.failed++;
    }
  }

  // Sweep orphan karst/* branches.
  const repos = new Set(candidates.map((c) => c.repo));
  for (const repoPath of repos) {
    const list = git(repoPath, ['branch', '--list', 'karst/*']);
    if (list.exitCode !== 0) continue;
    const branches = list.stdout.split('\n').map((l) => l.replace(/^\*?\s+/, '').trim()).filter(Boolean);
    for (const branch of branches) {
      // Check if used by any worktree or archive row.
      const inWorktree = store.db.prepare('SELECT 1 FROM worktrees WHERE repo = ? AND branch = ?').get(repoPath, branch);
      const inArchive = store.db.prepare('SELECT 1 FROM worktree_archives WHERE repo = ? AND branch = ?').get(repoPath, branch);
      if (!inWorktree && !inArchive) {
        const del = git(repoPath, ['branch', '-D', branch]);
        if (del.exitCode === 0) result.prunedBranches++;
      }
    }
  }

  // Sweep orphan archive refs.
  for (const repoPath of repos) {
    const list = git(repoPath, ['for-each-ref', '--format=%(refname)', 'refs/karst/archive/']);
    if (list.exitCode !== 0) continue;
    const refs = list.stdout.split('\n').filter(Boolean);
    for (const ref of refs) {
      const inArchive = store.db.prepare('SELECT 1 FROM worktree_archives WHERE archive_ref = ?').get(ref);
      if (!inArchive) {
        const del = git(repoPath, ['update-ref', '-d', ref]);
        if (del.exitCode === 0) result.prunedArchiveRefs++;
      }
    }
  }

  return result;
}
