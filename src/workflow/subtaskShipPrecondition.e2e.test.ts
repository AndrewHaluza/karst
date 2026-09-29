import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../store/db.js';
import { createTicket, getTicket, setStageCurrent } from '../store/tickets.js';
import { createSubtask } from './stages/subtask.js';
import { stageBlock } from '../store/stageBlocks.js';
import { ensureSubtaskForkPointOnParentBranch } from './stages/ship.js';
import { defaultGitRunner } from '../integrations/git.js';

/**
 * Real-git end-to-end for the sub-task ship precondition (NDL-85, design NDL-70
 * §4/§6), against a local bare origin. The spec's mechanism is a plain,
 * non-force `git push origin <forkSha>:refs/heads/<parentBranch>`; these tests
 * prove the actual git semantics it depends on:
 *  - when the parent's branch is behind the sub-task's fork point (the parent's
 *    newest commits are local-only), the push fast-forwards it and ship runs;
 *  - when a sibling has landed on `origin/<parentBranch>`, the fork point is no
 *    longer a fast-forward, so the push is rejected and `ship` parks
 *    `awaiting-subtask` naming the sibling — with no force and no rewind.
 */

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} in ${cwd}: ${r.stderr}`);
  return r.stdout ?? '';
}

interface Seeded {
  parentId: number;
  childId: number;
  siblingId: number | null;
  parentBranch: string;
  childBranch: string;
  repoPath: string;
  parentWt: string;
  childWt: string;
}

describe('sub-task ship precondition (real git)', () => {
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

    origin = tmp('karst-ss-origin-');
    git(origin, 'init', '-q', '--bare', '-b', 'main');

    repo = tmp('karst-ss-repo-');
    writeFileSync(join(repo, 'shared.txt'), 'base\n');
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

  /**
   * Parent + child (and optionally a landed sibling) worktrees off the parent
   * branch, registered in the store. `origin/<parentBranch>` is published at
   * the cut point; `parentLocalCommit` adds a parent commit that stays LOCAL
   * (the sub-task stacks on the parent's newest unpushed head).
   */
  function seed(
    key: string,
    opts: { parentLocalCommit?: boolean; withLandedSibling?: boolean } = {},
  ): Seeded {
    const parentBranch = `karst/${key}`;
    const childBranch = `${parentBranch}-s1`;
    const wtRoot = tmp('karst-ss-wt-');
    const parentWt = join(wtRoot, 'parent');
    const childWt = join(wtRoot, 'child');

    git(repo, 'worktree', 'add', '-q', '-b', parentBranch, parentWt);
    git(repo, 'push', '-q', 'origin', `${parentBranch}:refs/heads/${parentBranch}`);

    if (opts.parentLocalCommit) {
      writeFileSync(join(parentWt, 'parent.txt'), 'parent work\n');
      git(parentWt, 'add', '-A');
      git(parentWt, 'commit', '-q', '-m', 'parent local work');
    }

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
    setStageCurrent(store, child.id, 'ship');

    let siblingId: number | null = null;
    if (opts.withLandedSibling) {
      const siblingBranch = `${parentBranch}-s2`;
      const siblingWt = join(wtRoot, 'sibling');
      git(repo, 'worktree', 'add', '-q', '-b', siblingBranch, siblingWt, parentBranch);
      const sibling = createSubtask(store, parentId, { title: 'Sibling' });
      store.db
        .prepare('INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref) VALUES (?, ?, ?, ?, ?)')
        .run(sibling.id, repo, siblingWt, siblingBranch, parentBranch);
      setStageCurrent(store, sibling.id, 'done');
      siblingId = sibling.id;
    }

    return {
      parentId,
      childId: child.id,
      siblingId,
      parentBranch,
      childBranch,
      repoPath: repo,
      parentWt,
      childWt,
    };
  }

  const remoteHead = (branch: string): string =>
    git(repo, 'ls-remote', 'origin', `refs/heads/${branch}`).trim().split(/\s+/)[0] ?? '';

  it('fast-forwards origin/<parentBranch> to the fork point and does not park', async () => {
    const s = seed('SS-FF', { parentLocalCommit: true });
    const forkSha = git(s.parentWt, 'rev-parse', 'HEAD').trim();
    // The parent's newest commit is local-only, so origin is at its parent.
    expect(remoteHead(s.parentBranch)).not.toBe(forkSha);

    writeFileSync(join(s.childWt, 'child.txt'), 'child work\n');
    git(s.childWt, 'add', '-A');
    git(s.childWt, 'commit', '-q', '-m', 'child work');

    const outcome = await ensureSubtaskForkPointOnParentBranch(
      store,
      s.childId,
      s.repoPath,
      s.childWt,
      defaultGitRunner,
    );

    expect(outcome.diverged).toBe(false);
    expect(remoteHead(s.parentBranch)).toBe(forkSha);
    expect(stageBlock(store, s.childId, 'ship')).toBeNull();
  });

  it('parks ship awaiting-subtask when a sibling landed on the parent branch', async () => {
    const s = seed('SS-DIV', { withLandedSibling: true });
    const forkSha = git(s.childWt, 'rev-parse', 'HEAD').trim();

    writeFileSync(join(s.childWt, 'child.txt'), 'child work\n');
    git(s.childWt, 'add', '-A');
    git(s.childWt, 'commit', '-q', '-m', 'child work');

    // The sibling's PR merged into the parent branch: a NEW commit on top of the
    // fork point, so the child's fork point is no longer a fast-forward.
    writeFileSync(join(s.parentWt, 'sibling.txt'), 'sibling work\n');
    git(s.parentWt, 'add', '-A');
    git(s.parentWt, 'commit', '-q', '-m', 'sibling landed');
    git(s.parentWt, 'push', '-q', 'origin', `${s.parentBranch}:refs/heads/${s.parentBranch}`);
    const siblingSha = git(s.parentWt, 'rev-parse', 'HEAD').trim();
    expect(siblingSha).not.toBe(forkSha);

    const outcome = await ensureSubtaskForkPointOnParentBranch(
      store,
      s.childId,
      s.repoPath,
      s.childWt,
      defaultGitRunner,
    );

    expect(outcome.diverged).toBe(true);
    const block = stageBlock(store, s.childId, 'ship');
    expect(block?.kind).toBe('awaiting-subtask');
    const siblingKey = s.siblingId === null ? '' : getTicket(store, s.siblingId).key;
    expect(siblingKey).not.toBe('');
    expect(block?.reason).toBe(`parent branch must integrate ${siblingKey} first`);
    // No force, no rewind: the remote still carries the sibling's commit.
    expect(remoteHead(s.parentBranch)).toBe(siblingSha);
  });

  it('is a no-op for a ticket that has no parent', async () => {
    const topId = createTicket(store, { key: 'SS-TOP', title: 'Top', projectId: 1 }).id;
    setStageCurrent(store, topId, 'ship');

    const outcome = await ensureSubtaskForkPointOnParentBranch(
      store,
      topId,
      repo,
      repo,
      defaultGitRunner,
    );

    expect(outcome.diverged).toBe(false);
    expect(stageBlock(store, topId, 'ship')).toBeNull();
  });
});
