import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore } from '../store/db.js';
import { createTicket, setStageCurrent } from '../store/tickets.js';
import { createSubtask } from './stages/subtask.js';
import { setStage } from '../store/stages.js';
import { stageBlock } from '../store/stageBlocks.js';
import { integrateLandedSubtasks } from './subtaskIntegration.js';
import type { GitResult } from '../integrations/git.js';
import type { GitRunner } from '../integrations/git.js';

interface MockGitCall {
  args: string[];
  cwd: string;
  result: GitResult;
}

function makeStore() {
  return openStore(':memory:');
}

function makeParent(store: ReturnType<typeof openStore>, key: string): number {
  return createTicket(store, { key, title: 'Parent', projectId: 1 }).id;
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

function createMockGitRunner(): { runner: GitRunner; calls: MockGitCall[] } {
  const calls: MockGitCall[] = [];

  const runner: GitRunner = async (args, cwd) => {
    const call: MockGitCall = { args, cwd, result: { stdout: '', stderr: '', exitCode: 0 } };

    // Default successful responses
    if (args[0] === 'status') {
      call.result = { stdout: '', stderr: '', exitCode: 0 };
    } else if (args[0] === 'fetch') {
      call.result = { stdout: '', stderr: '', exitCode: 0 };
    } else if (args[0] === 'merge' && args[1] === '--ff-only') {
      call.result = { stdout: '', stderr: '', exitCode: 0 };
    } else if (args[0] === 'rev-parse' && args[1] === 'MERGE_HEAD') {
      call.result = { stdout: '', stderr: 'fatal: ambiguous argument \'MERGE_HEAD\'', exitCode: 128 };
    }

    calls.push(call);
    return call.result;
  };

  return { runner, calls };
}

describe('subtaskIntegration', () => {
  let store: ReturnType<typeof openStore>;

  beforeEach(() => {
    store = makeStore();
  });

  afterEach(() => {
    store.close();
  });

  describe('integrateLandedSubtasks', () => {
    it('does nothing when parent has no worktrees', async () => {
      const parentId = makeParent(store, 'P-1');
      setStageCurrent(store, parentId, 'impl');
      const { runner, calls } = createMockGitRunner();

      await integrateLandedSubtasks(store, parentId, runner);

      expect(calls).toHaveLength(0);
    });

    it('does nothing when parent has no landed sub-tasks', async () => {
      const parentId = makeParent(store, 'P-2');
      setStageCurrent(store, parentId, 'impl');
      addWorktree(store, parentId, 'api', 'karst/p-2', 'main');
      const { runner, calls } = createMockGitRunner();

      await integrateLandedSubtasks(store, parentId, runner);

      expect(calls).toHaveLength(0);
    });

    it('performs ff-only merge when successful', async () => {
      const parentId = makeParent(store, 'P-3');
      const parentBranch = 'karst/p-3';
      const parentPath = addWorktree(store, parentId, 'api', parentBranch, 'main');
      setStageCurrent(store, parentId, 'impl');

      const child = createSubtask(store, parentId, { title: 'Child' });
      const childBranch = `${parentBranch}-s1`;
      addWorktree(store, child.id, 'api', childBranch, parentBranch);
      setStageCurrent(store, child.id, 'done');

      const { runner, calls } = createMockGitRunner();
      await integrateLandedSubtasks(store, parentId, runner);

      // Should call: status (clean), fetch, merge --ff-only
      expect(calls.length).toBeGreaterThanOrEqual(2);
      expect(calls.some((c) => c.args[0] === 'status')).toBe(true);
      expect(calls.some((c) => c.args[0] === 'fetch')).toBe(true);
      expect(calls.some((c) => c.args[0] === 'merge' && c.args[1] === '--ff-only')).toBe(true);
    });

    it('parks awaiting-subtask when tree is dirty', async () => {
      const parentId = makeParent(store, 'P-4');
      const parentBranch = 'karst/p-4';
      addWorktree(store, parentId, 'api', parentBranch, 'main');
      setStageCurrent(store, parentId, 'impl');

      const child = createSubtask(store, parentId, { title: 'Child' });
      const childBranch = `${parentBranch}-s1`;
      addWorktree(store, child.id, 'api', childBranch, parentBranch);
      setStageCurrent(store, child.id, 'done');

      const { runner } = createMockGitRunner();
      // Override to report dirty tree
      const dirtyRunner: GitRunner = async (args) => {
        if (args[0] === 'status') {
          return { stdout: 'M file.ts\n', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      };

      await integrateLandedSubtasks(store, parentId, dirtyRunner);

      const block = stageBlock(store, parentId, 'impl');
      expect(block?.kind).toBe('awaiting-subtask');
      expect(block?.reason).toContain('commit or stash');
      expect(block?.reason).toContain(child.key);
    });

    it('parks subtask-integration-conflict on merge conflict', async () => {
      const parentId = makeParent(store, 'P-5');
      const parentBranch = 'karst/p-5';
      addWorktree(store, parentId, 'api', parentBranch, 'main');
      setStageCurrent(store, parentId, 'impl');

      const child = createSubtask(store, parentId, { title: 'Child' });
      const childBranch = `${parentBranch}-s1`;
      addWorktree(store, child.id, 'api', childBranch, parentBranch);
      setStageCurrent(store, child.id, 'done');

      let inMergeState = false;
      const conflictRunner: GitRunner = async (args, cwd) => {
        if (args[0] === 'status') {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (args[0] === 'fetch') {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (args[0] === 'merge') {
          if (args[1] === '--abort') {
            inMergeState = false;
            return { stdout: '', stderr: '', exitCode: 0 };
          }
          if (args[1] === '--ff-only') {
            // ff-only fails
            return { stdout: '', stderr: 'error: ff-only not possible', exitCode: 1 };
          }
          // merge --no-edit fails but enters merge state
          inMergeState = true;
          return { stdout: '', stderr: 'CONFLICT (content): Merge conflict', exitCode: 1 };
        }
        if (args[0] === 'rev-parse' && args[1] === 'MERGE_HEAD') {
          // Return merge head if in merge state
          if (inMergeState) {
            return { stdout: 'abc123\n', stderr: '', exitCode: 0 };
          }
          return { stdout: '', stderr: 'fatal: ambiguous argument \'MERGE_HEAD\'', exitCode: 128 };
        }
        if (args[0] === 'diff-index') {
          return { stdout: 'file1.ts\nfile2.ts\n', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      };

      await integrateLandedSubtasks(store, parentId, conflictRunner);

      const block = stageBlock(store, parentId, 'impl');
      expect(block?.kind).toBe('subtask-integration-conflict');
      expect(block?.reason).toContain(child.key);
      expect(block?.reason).toContain('merge conflict');
      expect(block?.reason).toContain('file1.ts');
      expect(block?.reason).toContain('file2.ts');
    });

    it('falls back to merge --no-edit when ff-only fails', async () => {
      const parentId = makeParent(store, 'P-6');
      const parentBranch = 'karst/p-6';
      const parentPath = addWorktree(store, parentId, 'api', parentBranch, 'main');
      setStageCurrent(store, parentId, 'impl');

      const child = createSubtask(store, parentId, { title: 'Child' });
      const childBranch = `${parentBranch}-s1`;
      addWorktree(store, child.id, 'api', childBranch, parentBranch);
      setStageCurrent(store, child.id, 'done');

      const { runner, calls } = createMockGitRunner();
      let mergeAttempts = 0;

      // Override runner to simulate ff-only failure
      const noFfRunner: GitRunner = async (args, cwd) => {
        if (args[0] === 'status') {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (args[0] === 'fetch') {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (args[0] === 'merge') {
          mergeAttempts++;
          if (args[1] === '--ff-only') {
            // ff-only fails
            return { stdout: '', stderr: 'error: ff-only not possible', exitCode: 1 };
          } else if (args[1] === '--no-edit') {
            // merge --no-edit succeeds
            return { stdout: '', stderr: '', exitCode: 0 };
          }
        }
        if (args[0] === 'rev-parse' && args[1] === 'MERGE_HEAD') {
          return { stdout: '', stderr: 'fatal: ambiguous', exitCode: 128 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      };

      await integrateLandedSubtasks(store, parentId, noFfRunner);

      // Should attempt both ff-only and merge --no-edit
      expect(mergeAttempts).toBeGreaterThanOrEqual(2);
      expect(stageBlock(store, parentId, 'impl')).toBeNull();
    });

    it('aborts merge on conflict and reports abort failures', async () => {
      const parentId = makeParent(store, 'P-7');
      const parentBranch = 'karst/p-7';
      addWorktree(store, parentId, 'api', parentBranch, 'main');
      setStageCurrent(store, parentId, 'impl');

      const child = createSubtask(store, parentId, { title: 'Child' });
      const childBranch = `${parentBranch}-s1`;
      addWorktree(store, child.id, 'api', childBranch, parentBranch);
      setStageCurrent(store, child.id, 'done');

      const abortFailureRunner: GitRunner = async (args) => {
        if (args[0] === 'status') {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (args[0] === 'fetch') {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (args[0] === 'merge') {
          return { stdout: '', stderr: '', exitCode: 1 };
        }
        if (args[0] === 'rev-parse' && args[1] === 'MERGE_HEAD') {
          return { stdout: 'abc123\n', stderr: '', exitCode: 0 };
        }
        if (args[0] === 'diff-index') {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (args[0] === 'merge' && args[1] === '--abort') {
          // abort fails
          return { stdout: '', stderr: 'error: cannot abort merge', exitCode: 1 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      };

      let debugMessages = '';
      const debug = (msg: string) => {
        debugMessages += msg + '\n';
      };

      await integrateLandedSubtasks(store, parentId, abortFailureRunner, debug);

      expect(debugMessages).toContain('merge --abort failed');
    });

    it('skips repos without branches', async () => {
      const parentId = makeParent(store, 'P-8');
      addWorktree(store, parentId, 'api', null, 'main');
      setStageCurrent(store, parentId, 'impl');

      const child = createSubtask(store, parentId, { title: 'Child' });
      addWorktree(store, child.id, 'api', 'child-branch', null);
      setStageCurrent(store, child.id, 'done');

      const { runner, calls } = createMockGitRunner();
      await integrateLandedSubtasks(store, parentId, runner);

      // Should not make any git calls since parent has no branch
      expect(calls).toHaveLength(0);
    });
  });
});
