import { describe, expect, it } from 'vitest';
import { openStore } from '../store/db.js';
import { createTicket } from '../store/tickets.js';
import { manifest, stack } from '../manifest/fixtures.js';
import type { GitRunner } from '../integrations/git.js';
import { detachSubtask, NotASubtaskError, SubtaskParentNotFoundError } from './detachSubtask.js';

function fixtureManifest() {
  return manifest(stack());
}

function seed() {
  const store = openStore(':memory:');
  const m = fixtureManifest();
  const repoPath = m.repositories.backend!.repoPath;

  // Create parent ticket
  const parent = createTicket(store, { key: 'C-1', title: 'parent' });
  store.db
    .prepare(
      `INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref, deps_mode)
       VALUES (?, ?, '/wt-parent', 'karst/feat/c-1', 'develop', 'inherited')`,
    )
    .run(parent.id, repoPath);

  // Create sub-task
  const subtask = createTicket(store, {
    key: 'C-1-s1',
    title: 'subtask',
    subtaskParentId: parent.id,
  });
  store.db
    .prepare(
      `INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref, deps_mode)
       VALUES (?, ?, '/wt-subtask', 'karst/feat/c-1-s1', 'karst/feat/c-1', 'inherited')`,
    )
    .run(subtask.id, repoPath);

  // Set selected_repos on both tickets
  store.db.prepare('UPDATE tickets SET selected_repos = ? WHERE id = ?').run('["backend"]', parent.id);
  store.db.prepare('UPDATE tickets SET selected_repos = ? WHERE id = ?').run('["backend"]', subtask.id);

  return { store, manifest: m, parentId: parent.id, subtaskId: subtask.id, repoPath };
}

const cleanGit: GitRunner = async () => ({ stdout: '', stderr: '', exitCode: 0 });

describe('detachSubtask', () => {
  it('clears subtask_parent_id and rebases onto the parent base', async () => {
    const { store, manifest: m, parentId, subtaskId, repoPath } = seed();
    const r = await detachSubtask({
      store,
      manifest: m,
      ticketId: subtaskId,
      git: cleanGit,
    });
    expect(r.ok).toBe(true);

    // subtask_parent_id should be cleared
    const row = store.db.prepare('SELECT subtask_parent_id FROM tickets WHERE id = ?').get(subtaskId) as {
      subtask_parent_id: number | null;
    };
    expect(row.subtask_parent_id).toBeNull();

    // base_ref should be updated to parent's base
    const wtRow = store.db
      .prepare('SELECT base_ref FROM worktrees WHERE ticket_id = ? AND repo = ?')
      .get(subtaskId, repoPath) as { base_ref: string };
    expect(wtRow.base_ref).toBe('develop');
  });

  it('throws NotASubtaskError for a non-subtask', async () => {
    const store = openStore(':memory:');
    const m = fixtureManifest();
    const ticket = createTicket(store, { key: 'C-1', title: 't' });
    store.db
      .prepare('UPDATE tickets SET selected_repos = ? WHERE id = ?')
      .run('["backend"]', ticket.id);

    await expect(
      detachSubtask({
        store,
        manifest: m,
        ticketId: ticket.id,
        git: cleanGit,
      }),
    ).rejects.toThrow(NotASubtaskError);
  });

  it('throws SubtaskParentNotFoundError for a missing parent', async () => {
    const store = openStore(':memory:');
    const m = fixtureManifest();
    const subtask = createTicket(store, { key: 'C-1-s1', title: 'subtask', subtaskParentId: 999 });
    store.db.prepare('UPDATE tickets SET selected_repos = ? WHERE id = ?').run('["backend"]', subtask.id);

    await expect(
      detachSubtask({
        store,
        manifest: m,
        ticketId: subtask.id,
        git: cleanGit,
      }),
    ).rejects.toThrow(SubtaskParentNotFoundError);
  });

  it('returns failure when rebase fails', async () => {
    const { store, manifest: m, subtaskId } = seed();
    const git: GitRunner = async (args) =>
      args[0] === 'rebase' && args[1] !== '--abort'
        ? { stdout: '', stderr: 'CONFLICT', exitCode: 1 }
        : { stdout: '', stderr: '', exitCode: 0 };

    const r = await detachSubtask({
      store,
      manifest: m,
      ticketId: subtaskId,
      git,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('rebase failed');

    // subtask_parent_id should NOT be cleared on failure
    const row = store.db
      .prepare('SELECT subtask_parent_id FROM tickets WHERE id = ?')
      .get(subtaskId) as { subtask_parent_id: number | null };
    expect(row.subtask_parent_id).not.toBeNull();
  });

  it('reports nonexistent ticket', async () => {
    const { store, manifest: m } = seed();
    const r = await detachSubtask({
      store,
      manifest: m,
      ticketId: 9999,
      git: cleanGit,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('does not exist');
  });
});
