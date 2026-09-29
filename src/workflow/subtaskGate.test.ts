import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore } from '../store/db.js';
import { createTicket, setStageCurrent } from '../store/tickets.js';
import { createSubtask } from './stages/subtask.js';
import { setStage } from '../store/stages.js';
import { stageBlock } from '../store/stageBlocks.js';
import { getTicket } from '../store/tickets.js';
import {
  openGatingSubtasks,
  describeAwaitingSubtask,
  settleSubtaskGate,
  reconcileAwaitingSubtaskBlock,
  onSubtaskLanded,
} from './subtaskGate.js';
import { integrateAndReleaseParent } from './subtaskIntegration.js';

function makeParent(store: ReturnType<typeof openStore>, key: string): number {
  return createTicket(store, { key, title: 'Parent', projectId: 1 }).id;
}

function addWorktree(
  store: ReturnType<typeof openStore>,
  ticketId: number,
  repo: string,
  branch: string,
  baseRef: string | null,
): void {
  store.db
    .prepare('INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref) VALUES (?, ?, ?, ?, ?)')
    .run(ticketId, repo, `/wt/${ticketId}/${repo}`, branch, baseRef);
}

/** A stacked parent+child fixture: parent worktree in `api`, one stacked child. */
function stacked(
  store: ReturnType<typeof openStore>,
  key: string,
): { parentId: number; childId: number; parentBranch: string } {
  const parentId = makeParent(store, key);
  const parentBranch = `karst/${key.toLowerCase()}`;
  addWorktree(store, parentId, 'api', parentBranch, 'main');
  const child = createSubtask(store, parentId, { title: 'Stacked', blocking: false });
  addWorktree(store, child.id, 'api', `${parentBranch}-s1`, parentBranch);
  // The parent only reaches ship AFTER its sub-task exists (a ship/done parent
  // refuses new sub-tasks, NDL-70 §3).
  setStageCurrent(store, parentId, 'ship');
  return { parentId, childId: child.id, parentBranch };
}

describe('subtaskGate', () => {
  let store = openStore(':memory:');

  beforeEach(() => {
    store.close();
    store = openStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  describe('openGatingSubtasks — leave-impl', () => {
    it('truth table: only direct, blocking, live children are open', () => {
      const parentId = makeParent(store, 'P-1');
      const blocking = createSubtask(store, parentId, { title: 'blocking', blocking: true }).id;
      const nonBlocking = createSubtask(store, parentId, { title: 'non-blocking', blocking: false }).id;
      const done = createSubtask(store, parentId, { title: 'done', blocking: true }).id;
      const archived = createSubtask(store, parentId, { title: 'archived', blocking: true }).id;
      const grandchild = createSubtask(store, parentId, { title: 'child', blocking: true }).id;
      const grandchildChild = createSubtask(store, grandchild, {
        title: 'grandchild',
        blocking: true,
      }).id;

      setStageCurrent(store, done, 'done');
      store.db
        .prepare("UPDATE tickets SET archived_at = '2026-01-01T00:00:00.000Z' WHERE id = ?")
        .run(archived);

      const open = openGatingSubtasks(store, parentId, 'leave-impl');
      const ids = open.map((s) => s.id);

      expect(ids).toContain(blocking);
      expect(ids).not.toContain(nonBlocking);
      expect(ids).not.toContain(done);
      expect(ids).not.toContain(archived);
      // A grandchild is not a direct child of the parent — recursion, not flattening.
      expect(ids).not.toContain(grandchildChild);
      expect(open.find((s) => s.id === blocking)?.stage).toBe('scope');
    });
  });

  describe('openGatingSubtasks — ship', () => {
    it('returns only started stacks cut from the parent branch', () => {
      const parentId = makeParent(store, 'P-2');
      const parentBranch = 'karst/p-2';
      addWorktree(store, parentId, 'api', parentBranch, 'main');

      const stacked = createSubtask(store, parentId, { title: 'stacked' }).id;
      addWorktree(store, stacked, 'api', `${parentBranch}-s1`, parentBranch);

      const notStacked = createSubtask(store, parentId, { title: 'not stacked' }).id;
      addWorktree(store, notStacked, 'api', 'karst/other', 'main');

      createSubtask(store, parentId, { title: 'never started' });

      const otherRepo = createSubtask(store, parentId, { title: 'other repo' }).id;
      // A stack in a repo the parent has no worktree in: no parent branch to match.
      addWorktree(store, otherRepo, 'web', 'karst/web', parentBranch);

      const landed = createSubtask(store, parentId, { title: 'landed' }).id;
      addWorktree(store, landed, 'api', `${parentBranch}-landed`, parentBranch);
      setStageCurrent(store, landed, 'done');

      const archived = createSubtask(store, parentId, { title: 'archived' }).id;
      addWorktree(store, archived, 'api', `${parentBranch}-arch`, parentBranch);
      store.db
        .prepare("UPDATE tickets SET archived_at = '2026-01-01T00:00:00.000Z' WHERE id = ?")
        .run(archived);

      setStageCurrent(store, parentId, 'ship');
      const open = openGatingSubtasks(store, parentId, 'ship');
      expect(open.map((s) => s.id)).toEqual([stacked]);
    });

    it('holds nothing when the parent has no worktree to stack on', () => {
      const parentId = makeParent(store, 'P-3');
      const child = createSubtask(store, parentId, { title: 'stacked?' }).id;
      addWorktree(store, child, 'api', 'karst/c', 'karst/parent');
      expect(openGatingSubtasks(store, parentId, 'ship')).toHaveLength(0);
    });
  });

  describe('describeAwaitingSubtask', () => {
    it('names every key with its stage', () => {
      expect(
        describeAwaitingSubtask([
          { id: 1, key: 'P-9-s1', stage: 'review' },
          { id: 2, key: 'P-9-s2', stage: 'impl' },
        ]),
      ).toBe('waiting on P-9-s1 (review), P-9-s2 (impl)');
    });
  });

  describe('settleSubtaskGate', () => {
    it('parks impl as passed with an awaiting-subtask block when closed', () => {
      const parentId = makeParent(store, 'P-4');
      createSubtask(store, parentId, { title: 'blocking', blocking: true });
      setStageCurrent(store, parentId, 'impl');

      const result = settleSubtaskGate(store, parentId, 'impl');

      expect(result.blocked).toBe(true);
      const block = stageBlock(store, parentId, 'impl');
      expect(block?.kind).toBe('awaiting-subtask');
      expect(block?.reason).toContain('P-4-s1');
      expect(block?.reason).toContain('(scope)');
    });

    it('parks ship as pending — nothing irreversible has run', () => {
      const { parentId } = stacked(store, 'P-5');

      settleSubtaskGate(store, parentId, 'ship');

      const ship = getTicket(store, parentId).stages.find((s) => s.stageKey === 'ship');
      expect(ship?.status).toBe('pending');
      expect(stageBlock(store, parentId, 'ship')?.kind).toBe('awaiting-subtask');
    });

    it('does not block when open, and clears a stale block', () => {
      const parentId = makeParent(store, 'P-6');
      const child = createSubtask(store, parentId, { title: 'blocking', blocking: true });
      setStageCurrent(store, parentId, 'impl');
      settleSubtaskGate(store, parentId, 'impl');
      expect(stageBlock(store, parentId, 'impl')?.kind).toBe('awaiting-subtask');

      setStageCurrent(store, child.id, 'done');
      const result = settleSubtaskGate(store, parentId, 'impl');

      expect(result.blocked).toBe(false);
      expect(stageBlock(store, parentId, 'impl')).toBeNull();
    });
  });

  describe('reconcileAwaitingSubtaskBlock', () => {
    it('refuses to clear while the predicate is still true', () => {
      const parentId = makeParent(store, 'P-7');
      createSubtask(store, parentId, { title: 'blocking', blocking: true });
      setStageCurrent(store, parentId, 'impl');
      settleSubtaskGate(store, parentId, 'impl');

      expect(reconcileAwaitingSubtaskBlock(store, parentId, 'impl').cleared).toBe(false);
      expect(stageBlock(store, parentId, 'impl')?.kind).toBe('awaiting-subtask');
    });

    it('clears once every blocking sub-task is done', () => {
      const parentId = makeParent(store, 'P-8');
      const child = createSubtask(store, parentId, { title: 'blocking', blocking: true });
      setStageCurrent(store, parentId, 'impl');
      settleSubtaskGate(store, parentId, 'impl');

      setStageCurrent(store, child.id, 'done');

      expect(reconcileAwaitingSubtaskBlock(store, parentId, 'impl').cleared).toBe(true);
      expect(stageBlock(store, parentId, 'impl')).toBeNull();
    });
  });

  describe('onSubtaskLanded', () => {
    it('clears and drives an impl-parked parent to uat', () => {
      const parentId = makeParent(store, 'P-9');
      const child = createSubtask(store, parentId, { title: 'blocking', blocking: true });
      setStageCurrent(store, parentId, 'impl');
      settleSubtaskGate(store, parentId, 'impl');

      setStageCurrent(store, child.id, 'done');
      const result = onSubtaskLanded(store, parentId);

      expect(result.cleared).toEqual(['impl']);
      expect(stageBlock(store, parentId, 'impl')).toBeNull();
      expect(getTicket(store, parentId).stageCurrent).toBe('uat');
    });

    it('clears a ship block but leaves ship for its confirm click', () => {
      const { parentId, childId } = stacked(store, 'P-10');
      settleSubtaskGate(store, parentId, 'ship');

      setStageCurrent(store, childId, 'done');
      const result = onSubtaskLanded(store, parentId);

      expect(result.cleared).toEqual(['ship']);
      expect(stageBlock(store, parentId, 'ship')).toBeNull();
      expect(getTicket(store, parentId).stageCurrent).toBe('ship');
    });

    it('does not integrate or drive while the parent is running', async () => {
      const parentId = makeParent(store, 'P-11');
      const child = createSubtask(store, parentId, { title: 'blocking', blocking: true });
      setStageCurrent(store, parentId, 'impl');
      settleSubtaskGate(store, parentId, 'impl');
      setStageCurrent(store, child.id, 'done');
      store.db.prepare("UPDATE tickets SET agent_state = 'running' WHERE id = ?").run(parentId);

      let gitCalls = 0;
      const git = async () => {
        gitCalls += 1;
        return { stdout: '', stderr: '', exitCode: 0 };
      };
      await integrateAndReleaseParent(store, parentId, git);

      expect(gitCalls).toBe(0);
      // Still re-derived: the block is stale.
      expect(stageBlock(store, parentId, 'impl')).toBeNull();
      // But not driven: the parent's own marker will advance it.
      expect(getTicket(store, parentId).stageCurrent).toBe('impl');
    });

    it('is a no-op for a parent with no block', () => {
      const parentId = makeParent(store, 'P-12');
      expect(onSubtaskLanded(store, parentId)).toEqual({ cleared: [] });
    });
  });
});
