import { describe, expect, it } from 'vitest';
import { openStore } from '../store/db.js';
import {
  createTicket,
  detachSubtaskParent,
  setStageCurrent,
} from '../store/tickets.js';
import { createSubtask } from './stages/subtask.js';
import { manifest, stack } from '../manifest/fixtures.js';
import { stageBlock } from '../store/stageBlocks.js';
import { settleSubtaskGate } from './subtaskGate.js';
import type { GitRunner } from '../integrations/git.js';
import {
  detachSubtask,
  BlockingSubtaskDetachError,
  DetachTicketNotFoundError,
  NotASubtaskError,
  SubtaskAgentRunningError,
  SubtaskHasOpenChildrenError,
  SubtaskParentNotFoundError,
} from './detachSubtask.js';

type Store = ReturnType<typeof openStore>;

function fixtureManifest() {
  return manifest(stack());
}

function addWorktree(
  store: Store,
  ticketId: number,
  repoPath: string,
  branch: string,
  baseRef: string | null,
): void {
  store.db
    .prepare(
      `INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref, deps_mode)
       VALUES (?, ?, ?, ?, ?, 'inherited')`,
    )
    .run(ticketId, repoPath, `/wt/${ticketId}${repoPath}`, branch, baseRef);
}

function parentRef(store: Store, ticketId: number): number | null {
  const row = store.db
    .prepare('SELECT subtask_parent_id FROM tickets WHERE id = ?')
    .get(ticketId) as { subtask_parent_id: number | null };
  return row.subtask_parent_id;
}

function baseRef(store: Store, ticketId: number, repoPath: string): string | null {
  const row = store.db
    .prepare('SELECT base_ref FROM worktrees WHERE ticket_id = ? AND repo = ?')
    .get(ticketId, repoPath) as { base_ref: string | null } | undefined;
  return row?.base_ref ?? null;
}

const cleanGit: GitRunner = async () => ({ stdout: '', stderr: '', exitCode: 0 });

/** A git runner that records calls and fails `git rebase` in one cwd. */
function failingGit(failCwd: string, calls: { cwd: string; args: string[] }[]): GitRunner {
  return async (args, cwd) => {
    calls.push({ cwd, args });
    if (args[0] === 'rebase' && args[1] !== '--abort' && cwd === failCwd) {
      return { stdout: '', stderr: 'CONFLICT', exitCode: 1 };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  };
}

describe('detachSubtask', () => {
  it('rebases onto the root base and clears the parent link (depth 1)', async () => {
    const store = openStore(':memory:');
    const m = fixtureManifest();
    const be = m.repositories.backend!.repoPath;
    const parent = createTicket(store, { key: 'C-1', title: 'parent' });
    addWorktree(store, parent.id, be, 'karst/feat/c-1', 'develop');
    const sub = createSubtask(store, parent.id, { title: 'sub' });
    addWorktree(store, sub.id, be, 'karst/feat/c-1-s1', 'karst/feat/c-1');

    const r = await detachSubtask({ store, manifest: m, ticketId: sub.id, git: cleanGit });

    expect(r.ok).toBe(true);
    expect(r.rebases.size).toBe(1);
    expect(parentRef(store, sub.id)).toBeNull();
    expect(baseRef(store, sub.id, be)).toBe('develop');
  });

  it('walks to the ROOT ancestor base for a nested sub-task (depth 2)', async () => {
    const store = openStore(':memory:');
    const m = fixtureManifest();
    const be = m.repositories.backend!.repoPath;
    const root = createTicket(store, { key: 'C-1', title: 'root' });
    addWorktree(store, root.id, be, 'karst/feat/c-1', 'develop');
    const mid = createSubtask(store, root.id, { title: 'mid' });
    addWorktree(store, mid.id, be, 'karst/feat/c-1-s1', 'karst/feat/c-1');
    const sub = createSubtask(store, mid.id, { title: 'sub' });
    addWorktree(store, sub.id, be, 'karst/feat/c-1-s1-s1', 'karst/feat/c-1-s1');

    const r = await detachSubtask({ store, manifest: m, ticketId: sub.id, git: cleanGit });

    expect(r.ok).toBe(true);
    // NOT the immediate parent's base ('karst/feat/c-1') — the root's base.
    expect(baseRef(store, sub.id, be)).toBe('develop');
    expect(parentRef(store, sub.id)).toBeNull();
  });

  it('detaches an unstarted sub-task by clearing the link with no git work', async () => {
    const store = openStore(':memory:');
    const m = fixtureManifest();
    const parent = createTicket(store, { key: 'C-1', title: 'parent' });
    const sub = createSubtask(store, parent.id, { title: 'never started' });

    const r = await detachSubtask({ store, manifest: m, ticketId: sub.id, git: cleanGit });

    expect(r.ok).toBe(true);
    expect(r.rebases.size).toBe(0);
    expect(parentRef(store, sub.id)).toBeNull();
  });

  it('throws NotASubtaskError for a non-subtask', async () => {
    const store = openStore(':memory:');
    const m = fixtureManifest();
    const ticket = createTicket(store, { key: 'C-1', title: 't' });

    await expect(
      detachSubtask({ store, manifest: m, ticketId: ticket.id, git: cleanGit }),
    ).rejects.toThrow(NotASubtaskError);
  });

  it('throws SubtaskParentNotFoundError for a missing parent', async () => {
    const store = openStore(':memory:');
    const m = fixtureManifest();
    const sub = createTicket(store, { key: 'C-1-s1', title: 'sub', subtaskParentId: 999 });

    await expect(
      detachSubtask({ store, manifest: m, ticketId: sub.id, git: cleanGit }),
    ).rejects.toThrow(SubtaskParentNotFoundError);
  });

  it('throws DetachTicketNotFoundError for a missing ticket (consistent error style)', async () => {
    const store = openStore(':memory:');
    const m = fixtureManifest();

    await expect(
      detachSubtask({ store, manifest: m, ticketId: 9999, git: cleanGit }),
    ).rejects.toThrow(DetachTicketNotFoundError);
  });

  it('refuses a blocking sub-task', async () => {
    const store = openStore(':memory:');
    const m = fixtureManifest();
    const be = m.repositories.backend!.repoPath;
    const parent = createTicket(store, { key: 'C-1', title: 'parent' });
    addWorktree(store, parent.id, be, 'karst/feat/c-1', 'develop');
    const sub = createSubtask(store, parent.id, { title: 'blocking', blocking: true });
    addWorktree(store, sub.id, be, 'karst/feat/c-1-s1', 'karst/feat/c-1');

    await expect(
      detachSubtask({ store, manifest: m, ticketId: sub.id, git: cleanGit }),
    ).rejects.toThrow(BlockingSubtaskDetachError);
    expect(parentRef(store, sub.id)).toBe(parent.id);
  });

  it('refuses a sub-task with open sub-tasks of its own, naming them', async () => {
    const store = openStore(':memory:');
    const m = fixtureManifest();
    const parent = createTicket(store, { key: 'C-1', title: 'parent' });
    const sub = createSubtask(store, parent.id, { title: 'sub' });
    const grandchild = createSubtask(store, sub.id, { title: 'grandchild' });

    const err = await detachSubtask({
      store,
      manifest: m,
      ticketId: sub.id,
      git: cleanGit,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SubtaskHasOpenChildrenError);
    expect((err as SubtaskHasOpenChildrenError).childKeys).toContain(grandchild.key);
  });

  it('refuses while the sub-task agent is running', async () => {
    const store = openStore(':memory:');
    const m = fixtureManifest();
    const parent = createTicket(store, { key: 'C-1', title: 'parent' });
    const sub = createSubtask(store, parent.id, { title: 'sub' });
    store.db.prepare("UPDATE tickets SET agent_state = 'running' WHERE id = ?").run(sub.id);

    await expect(
      detachSubtask({ store, manifest: m, ticketId: sub.id, git: cleanGit }),
    ).rejects.toThrow(SubtaskAgentRunningError);
  });

  it('clears a parked awaiting-subtask ship block on the parent', async () => {
    const store = openStore(':memory:');
    const m = fixtureManifest();
    const be = m.repositories.backend!.repoPath;
    const parent = createTicket(store, { key: 'C-1', title: 'parent' });
    addWorktree(store, parent.id, be, 'karst/feat/c-1', 'develop');
    const sub = createSubtask(store, parent.id, { title: 'stacked' });
    addWorktree(store, sub.id, be, 'karst/feat/c-1-s1', 'karst/feat/c-1');
    setStageCurrent(store, parent.id, 'ship');
    expect(settleSubtaskGate(store, parent.id, 'ship').blocked).toBe(true);
    expect(stageBlock(store, parent.id, 'ship')?.kind).toBe('awaiting-subtask');

    const r = await detachSubtask({ store, manifest: m, ticketId: sub.id, git: cleanGit });

    expect(r.ok).toBe(true);
    expect(stageBlock(store, parent.id, 'ship')).toBeNull();
  });

  it('reports a partial multi-repo failure and is idempotent on re-run', async () => {
    const store = openStore(':memory:');
    const m = fixtureManifest();
    const be = m.repositories.backend!.repoPath;
    const fe = m.repositories.frontend!.repoPath;
    const parent = createTicket(store, { key: 'C-1', title: 'parent' });
    addWorktree(store, parent.id, be, 'karst/feat/c-1', 'develop');
    addWorktree(store, parent.id, fe, 'karst/feat/c-1', 'develop');
    const sub = createSubtask(store, parent.id, { title: 'sub' });
    addWorktree(store, sub.id, be, 'karst/feat/c-1-s1', 'karst/feat/c-1');
    addWorktree(store, sub.id, fe, 'karst/feat/c-1-s1', 'karst/feat/c-1');

    const beCwd = `/wt/${sub.id}${be}`;
    const feCwd = `/wt/${sub.id}${fe}`;

    const calls1: { cwd: string; args: string[] }[] = [];
    const r1 = await detachSubtask({
      store,
      manifest: m,
      ticketId: sub.id,
      git: failingGit(feCwd, calls1),
    });

    expect(r1.ok).toBe(false);
    expect(r1.reason).toContain(be);
    expect(r1.reason).toContain(fe);
    expect(r1.reason).toContain('Re-running detach is safe');
    expect(baseRef(store, sub.id, be)).toBe('develop');
    expect(baseRef(store, sub.id, fe)).toBe('karst/feat/c-1');
    expect(parentRef(store, sub.id)).toBe(parent.id);

    // Re-running with a clean git finishes the job; the already-moved repo
    // short-circuits (changeBaseRef returns `already-based` with no git work).
    const calls2: { cwd: string; args: string[] }[] = [];
    const r2 = await detachSubtask({
      store,
      manifest: m,
      ticketId: sub.id,
      git: failingGit('/nonexistent', calls2),
    });

    expect(r2.ok).toBe(true);
    expect(baseRef(store, sub.id, fe)).toBe('develop');
    expect(parentRef(store, sub.id)).toBeNull();
    expect(calls2.some((c) => c.cwd === beCwd)).toBe(false);
  });

  it('detachSubtaskParent zeroes blocks_parent in the same guarded write', () => {
    const store = openStore(':memory:');
    const parent = createTicket(store, { key: 'C-1', title: 'parent' });
    const child = createTicket(store, {
      key: 'C-1-s1',
      title: 'child',
      subtaskParentId: parent.id,
      blocksParent: true,
    });

    expect(detachSubtaskParent(store, child.id, parent.id)).toBe(true);
    const row = store.db
      .prepare('SELECT subtask_parent_id, blocks_parent FROM tickets WHERE id = ?')
      .get(child.id) as { subtask_parent_id: number | null; blocks_parent: number | null };
    expect(row.subtask_parent_id).toBeNull();
    expect(row.blocks_parent).toBe(0);

    // Guarded: a mismatched expected parent matches no row and changes nothing.
    const child2 = createTicket(store, {
      key: 'C-1-s2',
      title: 'child2',
      subtaskParentId: parent.id,
    });
    expect(detachSubtaskParent(store, child2.id, 999)).toBe(false);
    expect(parentRef(store, child2.id)).toBe(parent.id);
  });
});
