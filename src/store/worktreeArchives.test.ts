import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from './db.js';
import { createTicket } from './tickets.js';
import {
  recordArchive,
  listArchives,
  getArchiveByPath,
  clearArchive,
  listArchivableWorktrees,
} from './worktreeArchives.js';

describe('worktreeArchives store', () => {
  let store: Store;
  beforeEach(() => {
    store = openStore(':memory:');
  });
  afterEach(() => store.close());

  it('records, lists, gets by path, and clears an archive row', () => {
    const t = createTicket(store, { key: 'K-1', title: 'one', source: 'manual' });
    recordArchive(store, {
      ticketId: t.id,
      repo: '/repo',
      path: '/repo/.karst/worktrees/K-1',
      branch: 'karst/K-1',
      baseRef: 'main',
      archiveRef: 'refs/karst/archive/K-1',
      method: 'git-ref',
    });

    const rows = listArchives(store, t.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.branch).toBe('karst/K-1');
    expect(rows[0]!.archiveRef).toBe('refs/karst/archive/K-1');

    const got = getArchiveByPath(store, t.id, '/repo/.karst/worktrees/K-1');
    expect(got?.baseRef).toBe('main');

    clearArchive(store, rows[0]!.id);
    expect(listArchives(store, t.id)).toHaveLength(0);
    expect(getArchiveByPath(store, t.id, '/repo/.karst/worktrees/K-1')).toBeNull();
  });

  it('listArchivableWorktrees selects archived/done tickets and skips running agents', () => {
    const archived = createTicket(store, { key: 'A', title: 'a', source: 'manual' });
    const done = createTicket(store, { key: 'D', title: 'd', source: 'manual' });
    const active = createTicket(store, { key: 'X', title: 'x', source: 'manual' });
    const running = createTicket(store, { key: 'R', title: 'r', source: 'manual' });

    store.db.prepare("UPDATE tickets SET archived_at = datetime('now') WHERE id = ?").run(archived.id);
    store.db.prepare("UPDATE tickets SET stage_current = 'done' WHERE id = ?").run(done.id);
    store.db.prepare("UPDATE tickets SET archived_at = datetime('now'), agent_state = 'running' WHERE id = ?").run(running.id);

    const mkWt = (id: number, key: string) =>
      store.db
        .prepare(
          `INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref, deps_mode)
           VALUES (?, '/repo', ?, ?, 'main', 'inherited')`,
        )
        .run(id, `/repo/.karst/worktrees/${key}`, `karst/${key}`);
    mkWt(archived.id, 'A');
    mkWt(done.id, 'D');
    mkWt(active.id, 'X');
    mkWt(running.id, 'R');

    const got = listArchivableWorktrees(store).map((w) => w.branch).sort();
    expect(got).toEqual(['karst/A', 'karst/D']);
  });

  it('listArchivableWorktrees with onlyArchived selects archived but not merely-done tickets', () => {
    const archived = createTicket(store, { key: 'A2', title: 'a2', source: 'manual' });
    const done = createTicket(store, { key: 'D2', title: 'd2', source: 'manual' });

    store.db.prepare("UPDATE tickets SET archived_at = datetime('now') WHERE id = ?").run(archived.id);
    store.db.prepare("UPDATE tickets SET stage_current = 'done' WHERE id = ?").run(done.id);

    const mkWt = (id: number, key: string) =>
      store.db
        .prepare(
          `INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref, deps_mode)
           VALUES (?, '/repo', ?, ?, 'main', 'inherited')`,
        )
        .run(id, `/repo/.karst/worktrees/${key}`, `karst/${key}`);
    mkWt(archived.id, 'A2');
    mkWt(done.id, 'D2');

    // onlyArchived must exclude a `done`-but-not-yet-archived ticket: its folder
    // survives until `archiveDoneAfterDays` stamps `archived_at`.
    const got = listArchivableWorktrees(store, { onlyArchived: true })
      .map((w) => w.branch)
      .sort();
    expect(got).toEqual(['karst/A2']);
  });

  it('listArchivableWorktrees scopes to a project when given one, and is unscoped by default', () => {
    const p1 = store.db
      .prepare('INSERT INTO projects (slug, name) VALUES (?, ?)')
      .run('proj-1', 'Project One').lastInsertRowid as number;
    const p2 = store.db
      .prepare('INSERT INTO projects (slug, name) VALUES (?, ?)')
      .run('proj-2', 'Project Two').lastInsertRowid as number;

    const t1 = createTicket(store, { key: 'P1', title: 'p1', source: 'manual', projectId: p1 });
    const t2 = createTicket(store, { key: 'P2', title: 'p2', source: 'manual', projectId: p2 });
    store.db.prepare("UPDATE tickets SET archived_at = datetime('now') WHERE id IN (?, ?)").run(t1.id, t2.id);

    const mkWt = (id: number, key: string) =>
      store.db
        .prepare(
          `INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref, deps_mode)
           VALUES (?, '/repo', ?, ?, 'main', 'inherited')`,
        )
        .run(id, `/repo/.karst/worktrees/${key}`, `karst/${key}`);
    mkWt(t1.id, 'P1');
    mkWt(t2.id, 'P2');

    const scoped = listArchivableWorktrees(store, { projectId: p1 }).map((w) => w.branch);
    expect(scoped).toEqual(['karst/P1']);

    const unscoped = listArchivableWorktrees(store).map((w) => w.branch).sort();
    expect(unscoped).toEqual(['karst/P1', 'karst/P2']);
  });
});
