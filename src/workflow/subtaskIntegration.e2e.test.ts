import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../store/db.js';
import { createTicket, setStageCurrent } from '../store/tickets.js';
import { createSubtask } from './stages/subtask.js';
import { stageBlock } from '../store/stageBlocks.js';
import { integrateLandedSubtasks } from './subtaskIntegration.js';
import { defaultGitRunner, type GitRunner, type GitResult } from '../integrations/git.js';

/**
 * Real-git end-to-end for sub-task integration (NDL-75, design §6), against a
 * local bare origin. The unit tests use a scripted runner; this file is what
 * proves the actual git semantics the spec depends on:
 *  - a fast-forward of `origin/<parentBranch>` lands the child's work;
 *  - a divergent parent takes the `--no-edit` merge (no rebase of history);
 *  - a conflict names the files from `git diff --name-only --diff-filter=U`
 *    (the read `diff-index … HEAD` gets wrong), aborts, and parks;
 *  - a dirty TRACKED tree refuses, but an untracked-only tree does not;
 *  - a failed `merge --abort` parks and leaves the tree mid-merge.
 *
 * The sub-task's "ship" is simulated exactly as production does it: push the
 * child's fork point onto `origin/<parentBranch>` (`git push origin
 * <childSha>:refs/heads/<parentBranch>`), never a local branch.
 */

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} in ${cwd}: ${r.stderr}`);
  return r.stdout ?? '';
}

function tryGit(cwd: string, ...args: string[]): boolean {
  return spawnSync('git', args, { cwd, encoding: 'utf8' }).status === 0;
}

interface Seeded {
  parentId: number;
  childId: number;
  parentBranch: string;
  childBranch: string;
  repoPath: string;
  parentWt: string;
  childWt: string;
}

describe('sub-task integration (real git)', () => {
  let store: Store;
  let origin: string;
  let repo: string;
  const dirs: string[] = [];

  const tmp = (prefix: string): string => {
    const d = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(d);
    return d;
  };

  beforeEach(() => {
    store = openStore(':memory:');

    origin = tmp('karst-si-origin-');
    git(origin, 'init', '-q', '--bare', '-b', 'main');

    repo = tmp('karst-si-repo-');
    writeFileSync(join(repo, 'shared.txt'), 'base\n');
    writeFileSync(join(repo, 'sibling.txt'), 'sibling\n');
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 't@k.local');
    git(repo, 'config', 'user.name', 't');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'init');
    git(repo, 'remote', 'add', 'origin', origin);
    git(repo, 'push', '-q', '-u', 'origin', 'main');
  });

  afterEach(() => {
    store.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /** Parent + child worktrees off the parent branch, registered in the store. */
  function seed(key: string): Seeded {
    const parentBranch = `karst/${key}`;
    const childBranch = `${parentBranch}-s1`;
    const wtRoot = tmp('karst-si-wt-');
    const parentWt = join(wtRoot, 'parent');
    const childWt = join(wtRoot, 'child');

    git(repo, 'worktree', 'add', '-q', '-b', parentBranch, parentWt);
    git(repo, 'worktree', 'add', '-q', '-b', childBranch, childWt, parentBranch);

    const parentId = createTicket(store, { key, title: 'Parent', projectId: 1 }).id;
    setStageCurrent(store, parentId, 'impl');
    store.db
      .prepare('INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref) VALUES (?, ?, ?, ?, ?)')
      .run(parentId, repo, parentWt, parentBranch, 'main');

    const child = createSubtask(store, parentId, { title: 'Child' });
    store.db
      .prepare('INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref) VALUES (?, ?, ?, ?, ?)')
      .run(child.id, repo, childWt, childBranch, parentBranch);
    setStageCurrent(store, child.id, 'done');

    return { parentId, childId: child.id, parentBranch, childBranch, repoPath: repo, parentWt, childWt };
  }

  /** Commit a file in a worktree and push HEAD onto origin/<parentBranch>. */
  function childShips(s: Seeded, file: string, content: string): string {
    writeFileSync(join(s.childWt, file), content);
    git(s.childWt, 'add', '-A');
    git(s.childWt, 'commit', '-q', '-m', `child: ${file}`);
    const sha = git(s.childWt, 'rev-parse', 'HEAD').trim();
    git(s.childWt, 'push', '-q', 'origin', `${sha}:refs/heads/${s.parentBranch}`);
    return sha;
  }

  it('fast-forwards the child work into the parent branch', async () => {
    const s = seed('E2E-FF');
    const childSha = childShips(s, 'child.txt', 'child work\n');

    const outcome = await integrateLandedSubtasks(store, s.parentId, defaultGitRunner);

    expect(outcome.parked).toBe(false);
    expect(git(s.parentWt, 'rev-parse', 'HEAD').trim()).toBe(childSha);
    expect(existsSync(join(s.parentWt, 'child.txt'))).toBe(true);
    expect(readFileSync(join(s.parentWt, 'child.txt'), 'utf8')).toBe('child work\n');
    expect(stageBlock(store, s.parentId, 'impl')).toBeNull();
  });

  it('does not re-refuse a dirty tree once the branch is already integrated', async () => {
    const s = seed('E2E-ALREADY');
    const childSha = childShips(s, 'child.txt', 'child work\n');
    const first = await integrateLandedSubtasks(store, s.parentId, defaultGitRunner);
    expect(first.parked).toBe(false);
    const integratedHead = git(s.parentWt, 'rev-parse', 'HEAD').trim();
    expect(integratedHead).toBe(childSha);

    // The landed-child row stays forever; dirty the tracked tree AFTER the
    // integration and re-run. Nothing to merge → no dirty refusal, no block.
    writeFileSync(join(s.parentWt, 'shared.txt'), 'uncommitted\n');
    const second = await integrateLandedSubtasks(store, s.parentId, defaultGitRunner);

    expect(second.parked).toBe(false);
    expect(stageBlock(store, s.parentId, 'impl')).toBeNull();
    expect(git(s.parentWt, 'rev-parse', 'HEAD').trim()).toBe(integratedHead);
  });

  it('takes a real merge commit when the parent branch diverged (no rebase)', async () => {
    const s = seed('E2E-MERGE');
    childShips(s, 'child.txt', 'child work\n');
    // The parent commits its OWN, non-overlapping work locally — now the child's
    // fork point (origin/<parentBranch>) is not an ancestor.
    writeFileSync(join(s.parentWt, 'parent.txt'), 'parent work\n');
    git(s.parentWt, 'add', '-A');
    git(s.parentWt, 'commit', '-q', '-m', 'parent work');

    const outcome = await integrateLandedSubtasks(store, s.parentId, defaultGitRunner);

    expect(outcome.parked).toBe(false);
    // A merge commit has two parents — proof the `--no-edit` fallback ran and
    // history was joined, not rebased.
    const parents = git(s.parentWt, 'rev-list', '--parents', '-n', '1', 'HEAD').trim().split(' ');
    expect(parents).toHaveLength(3);
    expect(existsSync(join(s.parentWt, 'child.txt'))).toBe(true);
    expect(existsSync(join(s.parentWt, 'parent.txt'))).toBe(true);
  });

  it('aborts a conflict, names the files from git state, and parks', async () => {
    const s = seed('E2E-CONFLICT');
    childShips(s, 'shared.txt', 'child edit\n');
    // Parent edits the SAME line locally: divergent + conflicting.
    writeFileSync(join(s.parentWt, 'shared.txt'), 'parent edit\n');
    git(s.parentWt, 'add', '-A');
    git(s.parentWt, 'commit', '-q', '-m', 'parent edit');

    const outcome = await integrateLandedSubtasks(store, s.parentId, defaultGitRunner);

    expect(outcome.parked).toBe(true);
    const block = stageBlock(store, s.parentId, 'impl');
    expect(block?.kind).toBe('subtask-integration-conflict');
    expect(block?.reason).toContain('shared.txt');
    // The abort really ran: no merge left in progress, tracked tree clean.
    expect(tryGit(s.parentWt, 'rev-parse', '--verify', 'MERGE_HEAD')).toBe(false);
    expect(git(s.parentWt, 'status', '--porcelain', '--untracked-files=no').trim()).toBe('');
  });

  it('refuses a dirty tracked parent tree, leaving the child work unmerged', async () => {
    const s = seed('E2E-DIRTY');
    childShips(s, 'child.txt', 'child work\n');
    const before = git(s.parentWt, 'rev-parse', 'HEAD').trim();
    // A tracked edit, uncommitted.
    writeFileSync(join(s.parentWt, 'shared.txt'), 'uncommitted\n');

    const outcome = await integrateLandedSubtasks(store, s.parentId, defaultGitRunner);

    expect(outcome.parked).toBe(true);
    const block = stageBlock(store, s.parentId, 'impl');
    expect(block?.kind).toBe('awaiting-subtask');
    expect(block?.reason).toContain('commit or stash parent changes to integrate');
    expect(git(s.parentWt, 'rev-parse', 'HEAD').trim()).toBe(before);
    expect(existsSync(join(s.parentWt, 'child.txt'))).toBe(false);
  });

  it('does NOT refuse an untracked-only tree', async () => {
    const s = seed('E2E-UNTRACKED');
    childShips(s, 'child.txt', 'child work\n');
    writeFileSync(join(s.parentWt, 'scratch.log'), 'not tracked\n');

    const outcome = await integrateLandedSubtasks(store, s.parentId, defaultGitRunner);

    expect(outcome.parked).toBe(false);
    expect(existsSync(join(s.parentWt, 'child.txt'))).toBe(true);
  });

  it('parks and leaves the tree mid-merge when merge --abort fails', async () => {
    const s = seed('E2E-ABORT');
    childShips(s, 'shared.txt', 'child edit\n');
    writeFileSync(join(s.parentWt, 'shared.txt'), 'parent edit\n');
    git(s.parentWt, 'add', '-A');
    git(s.parentWt, 'commit', '-q', '-m', 'parent edit');

    // Real git everywhere except a forced abort failure: the spec says a failed
    // abort must be REPORTED, not silently continued past.
    const forcedAbortFailure: GitRunner = async (args, cwd, opts): Promise<GitResult> => {
      if (args[0] === 'merge' && args[1] === '--abort') {
        return { stdout: '', stderr: 'forced abort failure', exitCode: 1 };
      }
      return defaultGitRunner(args, cwd, opts);
    };

    const outcome = await integrateLandedSubtasks(store, s.parentId, forcedAbortFailure);

    expect(outcome.parked).toBe(true);
    const block = stageBlock(store, s.parentId, 'impl');
    expect(block?.kind).toBe('subtask-integration-conflict');
    expect(block?.reason).toContain('abort failed');
    // The merge really is still in progress — the park is warranted.
    expect(tryGit(s.parentWt, 'rev-parse', '--verify', 'MERGE_HEAD')).toBe(true);
  });
});
