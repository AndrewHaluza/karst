import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../store/db.js';
import { makePortAllocator } from '../resolver/allocator.js';
import { defaultGitRunner } from '../integrations/git.js';
import { createTicket } from '../store/tickets.js';
import { createWorktree } from './worktree.js';
import { archiveInactiveWorktrees, resetArchiveSweepMemory } from './archiveBulk.js';

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

describe('archiveInactiveWorktrees — sweep progress (T952)', () => {
  let store: Store;
  let repo: { path: string; cleanup: () => void };
  let pid: number;
  beforeEach(() => {
    resetArchiveSweepMemory();
    store = openStore(':memory:');
    repo = makeRepo();
    pid = store.db.prepare('INSERT INTO projects (slug, name) VALUES (?, ?)').run('p', 'P')
      .lastInsertRowid as number;
  });
  afterEach(() => {
    store.close();
    repo.cleanup();
  });

  function archivedTicket(key: string) {
    const t = createTicket(store, { key, title: key, source: 'manual', projectId: pid });
    const w = createWorktree(store, { ticketId: t.id, repoPath: repo.path, slug: key, baseRef: 'develop' });
    store.db.prepare("UPDATE tickets SET archived_at = datetime('now') WHERE id = ?").run(t.id);
    return { t, w };
  }
  const alloc = () => makePortAllocator(store, [4000, 4100]);

  it('removes the row of a worktree whose folder is gone', async () => {
    const { t, w } = archivedTicket('G');
    rmSync(w.path, { recursive: true, force: true });
    const s = await archiveInactiveWorktrees(defaultGitRunner, store, alloc(), { projectId: pid });
    expect(s.cleared).toBe(1);
    expect(s.skipped).toBe(0);
    expect(store.db.prepare('SELECT COUNT(*) c FROM worktrees WHERE ticket_id = ?').get(t.id)).toEqual({ c: 0 });
  });

  it('removes a stale index.lock nobody holds, then archives', async () => {
    const { w } = archivedTicket('L');
    const lock = join(git(w.path, 'rev-parse', '--absolute-git-dir').trim(), 'index.lock');
    writeFileSync(lock, '');
    const s = await archiveInactiveWorktrees(defaultGitRunner, store, alloc(), {
      projectId: pid,
      archiveDeps: { staleLockMs: 0, isLockHolder: async () => false },
    });
    expect(s.archived).toBe(1);
    expect(existsSync(lock)).toBe(false);
  });

  it('skips with "stale index.lock" when the holder cannot be checked, logging once', async () => {
    const { w } = archivedTicket('H');
    writeFileSync(join(git(w.path, 'rev-parse', '--absolute-git-dir').trim(), 'index.lock'), '');
    const lines: string[] = [];
    const sweeps: number[] = [];
    const opts = {
      projectId: pid,
      beforeRemove: async () => void sweeps.push(1),
      archiveDeps: { staleLockMs: 0, isLockHolder: async () => null },
      log: { info: (m: string) => void lines.push(m), warn: (m: string) => void lines.push(m) },
    };
    for (let i = 0; i < 2; i += 1) {
      const s = await archiveInactiveWorktrees(defaultGitRunner, store, alloc(), opts);
      expect(s.skipped).toBe(1);
    }
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('stale index.lock');
    expect(lines[0]).toContain(w.path);
    expect(sweeps).toHaveLength(0);
  });

  it('logs a failure at warn and does not re-run the final sweep next tick', async () => {
    const { w } = archivedTicket('F');
    const warns: string[] = [];
    const sweeps: number[] = [];
    const opts = {
      projectId: pid,
      beforeRemove: async () => {
        sweeps.push(1);
        throw new Error('boom');
      },
      log: { info: () => {}, warn: (m: string) => void warns.push(m) },
    };
    expect((await archiveInactiveWorktrees(defaultGitRunner, store, alloc(), opts)).failed).toBe(1);
    const second = await archiveInactiveWorktrees(defaultGitRunner, store, alloc(), opts);
    expect(second).toMatchObject({ failed: 0, skipped: 1 });
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('boom');
    expect(warns[0]).toContain(w.path);
    expect(sweeps).toHaveLength(1);
  });

  it('selects an archived ticket with stale agent_state=running only when no session is live', async () => {
    const { t } = archivedTicket('R');
    store.db.prepare("UPDATE tickets SET agent_state = 'running' WHERE id = ?").run(t.id);
    // Archived just now: another window may own a live session, so it stays put.
    const fresh = await archiveInactiveWorktrees(defaultGitRunner, store, alloc(), {
      projectId: pid,
      isSessionLive: () => false,
    });
    expect(fresh.archived).toBe(0);
    store.db
      .prepare("UPDATE tickets SET archived_at = datetime('now', '-2 hours') WHERE id = ?")
      .run(t.id);
    const live = await archiveInactiveWorktrees(defaultGitRunner, store, alloc(), {
      projectId: pid,
      isSessionLive: () => true,
    });
    expect(live.archived).toBe(0);
    const stale = await archiveInactiveWorktrees(defaultGitRunner, store, alloc(), {
      projectId: pid,
      isSessionLive: () => false,
    });
    expect(stale.archived).toBe(1);
  });
});
