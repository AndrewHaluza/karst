import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../store/db.js';
import { makePortAllocator } from '../resolver/allocator.js';
import { defaultGitRunner } from '../integrations/git.js';
import { createTicket } from '../store/tickets.js';
import { createWorktree } from './worktree.js';
import { archiveInactiveWorktrees } from './archiveBulk.js';

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

function makeRepo(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'karst-bulk-'));
  writeFileSync(join(dir, 'index.js'), 'console.log(1);\n');
  git(dir, 'init', '-q', '-b', 'develop');
  git(dir, 'config', 'user.email', 'test@karst.local');
  git(dir, 'config', 'user.name', 'test');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
  return { path: dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('archiveInactiveWorktrees', () => {
  let store: Store;
  let repo: { path: string; cleanup: () => void };
  beforeEach(() => {
    store = openStore(':memory:');
    repo = makeRepo();
  });
  afterEach(() => {
    store.close();
    repo.cleanup();
  });

  it('archives archived + done tickets, skips the active one', async () => {
    const p1 = store.db
      .prepare('INSERT INTO projects (slug, name) VALUES (?, ?)')
      .run('proj-1', 'Project One').lastInsertRowid as number;
    const arch = createTicket(store, { key: 'A', title: 'a', source: 'manual', projectId: p1 });
    const done = createTicket(store, { key: 'D', title: 'd', source: 'manual', projectId: p1 });
    const active = createTicket(store, { key: 'X', title: 'x', source: 'manual', projectId: p1 });

    for (const [t, key] of [[arch, 'A'], [done, 'D'], [active, 'X']] as const) {
      createWorktree(store, { ticketId: t.id, repoPath: repo.path, slug: key, baseRef: 'develop' });
    }
    store.db.prepare("UPDATE tickets SET archived_at = datetime('now') WHERE id = ?").run(arch.id);
    store.db.prepare("UPDATE tickets SET stage_current = 'done' WHERE id = ?").run(done.id);

    const alloc = makePortAllocator(store, [4000, 4100]);
    const summary = await archiveInactiveWorktrees(defaultGitRunner, store, alloc, { projectId: p1 });

    expect(summary.archived).toBe(2);
    expect(summary.failed).toBe(0);
    // active ticket's worktree row survives
    const remaining = store.db.prepare('SELECT COUNT(*) AS n FROM worktrees').get() as { n: number };
    expect(remaining.n).toBe(1);
  });

  // P2-17: this is a destructive sweep; an unbound scope used to fall back to
  // the store's all-projects query and reap every other IDE window's worktrees.
  // It must refuse instead.
  it('refuses an unbound scope without archiving any project\'s worktrees', async () => {
    const arch = createTicket(store, { key: 'U1', title: 'u1', source: 'manual' });
    createWorktree(store, { ticketId: arch.id, repoPath: repo.path, slug: 'U1', baseRef: 'develop' });
    store.db.prepare("UPDATE tickets SET archived_at = datetime('now') WHERE id = ?").run(arch.id);

    const alloc = makePortAllocator(store, [4000, 4100]);
    await expect(
      archiveInactiveWorktrees(defaultGitRunner, store, alloc, {
        projectId: undefined as unknown as number,
      }),
    ).rejects.toThrow(/refusing an unscoped sweep/);

    // Nothing was reaped.
    const remaining = store.db.prepare('SELECT COUNT(*) AS n FROM worktrees').get() as { n: number };
    expect(remaining.n).toBe(1);
  });

  it('a scoped run skips another project\'s inactive worktree', async () => {
    const p1 = store.db
      .prepare('INSERT INTO projects (slug, name) VALUES (?, ?)')
      .run('proj-1', 'Project One').lastInsertRowid as number;
    const p2 = store.db
      .prepare('INSERT INTO projects (slug, name) VALUES (?, ?)')
      .run('proj-2', 'Project Two').lastInsertRowid as number;

    const t1 = createTicket(store, { key: 'P1', title: 'p1', source: 'manual', projectId: p1 });
    const t2 = createTicket(store, { key: 'P2', title: 'p2', source: 'manual', projectId: p2 });

    for (const [t, key] of [[t1, 'P1'], [t2, 'P2']] as const) {
      createWorktree(store, { ticketId: t.id, repoPath: repo.path, slug: key, baseRef: 'develop' });
    }
    store.db.prepare("UPDATE tickets SET archived_at = datetime('now') WHERE id IN (?, ?)").run(t1.id, t2.id);

    const alloc = makePortAllocator(store, [4000, 4100]);
    const summary = await archiveInactiveWorktrees(defaultGitRunner, store, alloc, { projectId: p1 });

    expect(summary.archived).toBe(1);
    expect(summary.failed).toBe(0);
    // project P2's worktree row survives untouched
    const remaining = store.db
      .prepare('SELECT COUNT(*) AS n FROM worktrees WHERE ticket_id = ?')
      .get(t2.id) as { n: number };
    expect(remaining.n).toBe(1);
  });
});
