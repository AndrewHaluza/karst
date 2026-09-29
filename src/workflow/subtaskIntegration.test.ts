import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore } from '../store/db.js';
import { createTicket, setStageCurrent } from '../store/tickets.js';
import { createSubtask } from './stages/subtask.js';
import { stageBlock } from '../store/stageBlocks.js';
import { integrateLandedSubtasks } from './subtaskIntegration.js';
import type { GitResult, GitRunner } from '../integrations/git.js';

function makeStore() {
  return openStore(':memory:');
}

function addWorktree(
  store: ReturnType<typeof openStore>,
  ticketId: number,
  repo: string,
  branch: string | null,
  baseRef: string | null,
): string {
  const path = `/wt/${ticketId}/${repo}`;
  store.db
    .prepare('INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref) VALUES (?, ?, ?, ?, ?)')
    .run(ticketId, repo, path, branch, baseRef);
  return path;
}

/** A parent at impl with one landed, stacked sub-task in `api`. */
function parentWithLandedChild(store: ReturnType<typeof openStore>, key: string) {
  const parentId = createTicket(store, { key, title: 'Parent', projectId: 1 }).id;
  const parentBranch = `karst/${key}`;
  addWorktree(store, parentId, 'api', parentBranch, 'main');
  setStageCurrent(store, parentId, 'impl');
  const child = createSubtask(store, parentId, { title: 'Child' });
  addWorktree(store, child.id, 'api', `${parentBranch}-s1`, parentBranch);
  setStageCurrent(store, child.id, 'done');
  return { parentId, parentBranch, child };
}

/** A scripted runner: the first prefix that matches wins; default is success. */
function runnerWith(
  handlers: ReadonlyArray<readonly [prefix: string, result: GitResult]>,
): { runner: GitRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: GitRunner = async (args) => {
    calls.push([...args]);
    const joined = args.join(' ');
    for (const [prefix, result] of handlers) {
      if (joined.startsWith(prefix)) return result;
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  };
  return { runner, calls };
}

const OK: GitResult = { stdout: '', stderr: '', exitCode: 0 };
const FAIL = (stderr: string): GitResult => ({ stdout: '', stderr, exitCode: 1 });
/** `git merge-base --is-ancestor` exit 1 = not an ancestor → a merge is needed. */
const MERGE_NEEDED: GitResult = { stdout: '', stderr: '', exitCode: 1 };

describe('subtaskIntegration', () => {
  let store: ReturnType<typeof openStore>;

  beforeEach(() => {
    store = makeStore();
  });

  afterEach(() => {
    store.close();
  });

  it('does nothing when parent has no worktrees', async () => {
    const parentId = createTicket(store, { key: 'P-1', title: 'Parent', projectId: 1 }).id;
    setStageCurrent(store, parentId, 'impl');
    const { runner, calls } = runnerWith([]);

    const outcome = await integrateLandedSubtasks(store, parentId, runner);

    expect(outcome.parked).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('does nothing when no sub-task has landed', async () => {
    const parentId = createTicket(store, { key: 'P-2', title: 'Parent', projectId: 1 }).id;
    addWorktree(store, parentId, 'api', 'karst/p-2', 'main');
    setStageCurrent(store, parentId, 'impl');
    const { runner, calls } = runnerWith([]);

    await integrateLandedSubtasks(store, parentId, runner);

    expect(calls).toHaveLength(0);
  });

  it('defers while the parent agent is running, touching no git', async () => {
    const { parentId } = parentWithLandedChild(store, 'P-3');
    store.db.prepare("UPDATE tickets SET agent_state = 'running' WHERE id = ?").run(parentId);
    const { runner, calls } = runnerWith([]);

    const outcome = await integrateLandedSubtasks(store, parentId, runner);

    expect(outcome.parked).toBe(false);
    expect(outcome.deferred).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('fetches and ff-only merges the remote parent branch', async () => {
    const { parentId, parentBranch } = parentWithLandedChild(store, 'P-4');
    const { runner, calls } = runnerWith([['merge-base', MERGE_NEEDED]]);

    const outcome = await integrateLandedSubtasks(store, parentId, runner);

    expect(outcome.parked).toBe(false);
    expect(calls).toContainEqual(['fetch', 'origin', parentBranch]);
    expect(calls).toContainEqual(['merge', '--ff-only', `origin/${parentBranch}`]);
  });

  it('falls back to merge --no-edit when ff-only fails', async () => {
    const { parentId, parentBranch } = parentWithLandedChild(store, 'P-5');
    const { runner, calls } = runnerWith([
      ['merge-base', MERGE_NEEDED],
      ['merge --ff-only', FAIL('not possible')],
    ]);

    const outcome = await integrateLandedSubtasks(store, parentId, runner);

    expect(outcome.parked).toBe(false);
    expect(calls).toContainEqual(['merge', '--no-edit', `origin/${parentBranch}`]);
  });

  it('refuses a dirty tracked tree and names the sub-task', async () => {
    const { parentId, child } = parentWithLandedChild(store, 'P-6');
    const { runner, calls } = runnerWith([
      ['merge-base', MERGE_NEEDED],
      ['status', { stdout: 'M file.ts\n', stderr: '', exitCode: 0 }],
    ]);

    const outcome = await integrateLandedSubtasks(store, parentId, runner);

    expect(outcome.parked).toBe(true);
    // Fetch runs first now, but the merge must never run on a dirty tree.
    expect(calls.some((c) => c[0] === 'merge')).toBe(false);
    const block = stageBlock(store, parentId, 'impl');
    expect(block?.kind).toBe('awaiting-subtask');
    expect(block?.reason).toContain('commit or stash parent changes to integrate');
    expect(block?.reason).toContain(child.key);
  });

  it('parks awaiting-subtask when git status fails', async () => {
    const { parentId } = parentWithLandedChild(store, 'P-7');
    const { runner } = runnerWith([
      ['merge-base', MERGE_NEEDED],
      ['status', FAIL('boom')],
    ]);

    const outcome = await integrateLandedSubtasks(store, parentId, runner);

    expect(outcome.parked).toBe(true);
    const block = stageBlock(store, parentId, 'impl');
    expect(block?.kind).toBe('awaiting-subtask');
    expect(block?.reason).toContain('git status failed');
  });

  it('parks awaiting-subtask when the fetch fails', async () => {
    const { parentId } = parentWithLandedChild(store, 'P-8');
    const { runner } = runnerWith([['fetch', FAIL('unreachable')]]);

    const outcome = await integrateLandedSubtasks(store, parentId, runner);

    expect(outcome.parked).toBe(true);
    const block = stageBlock(store, parentId, 'impl');
    expect(block?.kind).toBe('awaiting-subtask');
    expect(block?.reason).toContain('git fetch failed');
  });

  it('parks subtask-integration-conflict naming the files from git state', async () => {
    const { parentId, child } = parentWithLandedChild(store, 'P-9');
    const { runner, calls } = runnerWith([
      ['merge-base', MERGE_NEEDED],
      ['merge --ff-only', FAIL('not possible')],
      ['merge --no-edit', FAIL('CONFLICT')],
      ['rev-parse --verify MERGE_HEAD', { stdout: 'abc\n', stderr: '', exitCode: 0 }],
      ['diff --name-only', { stdout: 'a.ts\nb.ts\n', stderr: '', exitCode: 0 }],
      ['merge --abort', OK],
    ]);

    const outcome = await integrateLandedSubtasks(store, parentId, runner);

    expect(outcome.parked).toBe(true);
    expect(calls).toContainEqual(['diff', '--name-only', '--diff-filter=U']);
    const block = stageBlock(store, parentId, 'impl');
    expect(block?.kind).toBe('subtask-integration-conflict');
    expect(block?.reason).toContain(child.key);
    expect(block?.reason).toContain('a.ts');
    expect(block?.reason).toContain('b.ts');
  });

  it('parks with manual-cleanup wording when merge --abort fails', async () => {
    const { parentId } = parentWithLandedChild(store, 'P-10');
    const { runner } = runnerWith([
      ['merge-base', MERGE_NEEDED],
      ['merge --ff-only', FAIL('not possible')],
      ['merge --no-edit', FAIL('CONFLICT')],
      ['rev-parse --verify MERGE_HEAD', { stdout: 'abc\n', stderr: '', exitCode: 0 }],
      ['diff --name-only', OK],
      ['merge --abort', FAIL('cannot abort')],
    ]);

    const outcome = await integrateLandedSubtasks(store, parentId, runner);

    expect(outcome.parked).toBe(true);
    const block = stageBlock(store, parentId, 'impl');
    expect(block?.kind).toBe('subtask-integration-conflict');
    expect(block?.reason).toContain('abort failed');
  });

  it('parks awaiting-subtask when the merge fails without entering a conflict', async () => {
    const { parentId } = parentWithLandedChild(store, 'P-11');
    const { runner } = runnerWith([
      ['merge-base', MERGE_NEEDED],
      ['merge --ff-only', FAIL('not possible')],
      ['merge --no-edit', FAIL('would be overwritten')],
      ['rev-parse --verify MERGE_HEAD', FAIL('not a merge')],
    ]);

    const outcome = await integrateLandedSubtasks(store, parentId, runner);

    expect(outcome.parked).toBe(true);
    const block = stageBlock(store, parentId, 'impl');
    expect(block?.kind).toBe('awaiting-subtask');
    expect(block?.reason).toContain('git merge');
  });

  it('skips the dirty check when the branch is already integrated', async () => {
    const { parentId } = parentWithLandedChild(store, 'P-12');
    // `origin/<branch>` already an ancestor of HEAD → nothing to merge, so a
    // dirty tracked tree must NOT refuse (the deadlock the Architect found).
    const { runner, calls } = runnerWith([
      ['merge-base', OK],
      ['status', { stdout: 'M file.ts\n', stderr: '', exitCode: 0 }],
    ]);

    const outcome = await integrateLandedSubtasks(store, parentId, runner);

    expect(outcome.parked).toBe(false);
    expect(stageBlock(store, parentId, 'impl')).toBeNull();
    expect(calls.some((c) => c[0] === 'status')).toBe(false);
    expect(calls.some((c) => c[0] === 'merge')).toBe(false);
  });
});
