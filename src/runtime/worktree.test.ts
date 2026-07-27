import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync, symlinkSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../store/db.js';
import { makePortAllocator } from '../resolver/allocator.js';
import { createWorktree, removeWorktree, reinstallDeps, ticketIdForWorktreePath } from './worktree.js';

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

/** A repo with one tracked file + a tracked .gitignore, on branch `develop`. */
function makeRepo(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'karst-wt-'));
  writeFileSync(join(dir, 'index.js'), 'console.log(1);\n');
  writeFileSync(join(dir, '.gitignore'), 'node_modules/\n');
  writeFileSync(join(dir, 'package.json'), '{"name":"fixture","scripts":{"noop":"true"}}\n');
  git(dir, 'init', '-q', '-b', 'develop');
  git(dir, 'config', 'user.email', 'test@karst.local');
  git(dir, 'config', 'user.name', 'test');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
  return { path: dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('worktree lifecycle', () => {
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

  it('creates the worktree at the nested .karst path on a new branch from baseRef', () => {
    const rec = createWorktree(store, {
      ticketId: 1,
      repoPath: repo.path,
      slug: 'PROJ-142',
      baseRef: 'develop',
    });
    const expectedPath = join(repo.path, '.karst', 'worktrees', 'PROJ-142');
    expect(rec.path).toBe(expectedPath);
    expect(existsSync(expectedPath)).toBe(true);
    expect(existsSync(join(expectedPath, 'index.js'))).toBe(true);
    expect(rec.baseRef).toBe('develop');
    expect(rec.depsMode).toBe('inherited');

    // branch was created and is checked out in the worktree
    const branch = git(expectedPath, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
    expect(branch).toBe(rec.branch);
    expect(branch).not.toBe('develop');
  });

  it('attaches to an existing free branch instead of failing to recreate it', () => {
    // Plant a leftover branch (as a prior aborted spin / teardown would leave),
    // not bound to any worktree.
    git(repo.path, 'branch', 'karst/1-frontend', 'develop');

    const rec = createWorktree(store, {
      ticketId: 1,
      repoPath: repo.path,
      slug: '1-frontend',
      baseRef: 'develop',
    });

    expect(rec.branch).toBe('karst/1-frontend');
    const head = git(rec.path, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
    expect(head).toBe('karst/1-frontend');
    const row = store.db
      .prepare('SELECT branch FROM worktrees WHERE ticket_id = 1')
      .get() as { branch: string };
    expect(row.branch).toBe('karst/1-frontend');
  });

  it('reuses the existing branch commit — does not recreate from baseRef', () => {
    // Give the leftover branch a distinct commit ahead of develop.
    git(repo.path, 'branch', 'karst/1-x', 'develop');
    git(repo.path, 'switch', '-q', 'karst/1-x');
    writeFileSync(join(repo.path, 'extra.txt'), 'leftover\n');
    git(repo.path, 'add', '.');
    git(repo.path, 'commit', '-q', '-m', 'leftover work');
    const leftoverSha = git(repo.path, 'rev-parse', 'karst/1-x').trim();
    git(repo.path, 'switch', '-q', 'develop');

    const rec = createWorktree(store, {
      ticketId: 1,
      repoPath: repo.path,
      slug: '1-x',
      baseRef: 'develop',
    });

    // Worktree sits on the leftover branch's own commit, not a fresh branch off develop.
    expect(git(rec.path, 'rev-parse', 'HEAD').trim()).toBe(leftoverSha);
    expect(existsSync(join(rec.path, 'extra.txt'))).toBe(true);
  });

  it('adopts an already-created worktree on retry — no duplicate row, no git error', () => {
    const first = createWorktree(store, {
      ticketId: 1,
      repoPath: repo.path,
      slug: '1-frontend',
      baseRef: 'develop',
    });

    // Re-run as a resumed spin would: git worktree + row already present.
    const again = createWorktree(store, {
      ticketId: 1,
      repoPath: repo.path,
      slug: '1-frontend',
      baseRef: 'develop',
    });

    expect(again.path).toBe(first.path);
    expect(again.branch).toBe(first.branch);
    const rows = store.db
      .prepare('SELECT COUNT(*) AS n FROM worktrees WHERE ticket_id = 1 AND path = ?')
      .get(first.path) as { n: number };
    expect(rows.n).toBe(1); // adopted, not re-inserted
  });

  it('adopts a git worktree with no DB row (DB reset while worktree survived) — inserts a row', () => {
    // Simulate the store being cleared out-of-band (e.g. the user wiped the DB
    // between test runs) while the git worktree on disk survives. A fresh create
    // for the same slug must recover a DB row so the session can find it.
    const first = createWorktree(store, {
      ticketId: 1,
      repoPath: repo.path,
      slug: '1-frontend',
      baseRef: 'develop',
    });
    store.db.prepare('DELETE FROM worktrees').run(); // DB reset, git worktree stays

    const again = createWorktree(store, {
      ticketId: 1,
      repoPath: repo.path,
      slug: '1-frontend',
      baseRef: 'develop',
    });

    expect(again.path).toBe(first.path);
    const rows = store.db
      .prepare('SELECT COUNT(*) AS n FROM worktrees WHERE ticket_id = 1 AND path = ?')
      .get(first.path) as { n: number };
    expect(rows.n).toBe(1); // row recovered, so listWorktreesByTicket finds it
  });

  it('records the worktree row', () => {
    createWorktree(store, { ticketId: 7, repoPath: repo.path, slug: 's', baseRef: 'develop' });
    const row = store.db
      .prepare('SELECT path, branch, base_ref, deps_mode FROM worktrees WHERE ticket_id = ?')
      .get(7) as { path: string; branch: string; base_ref: string; deps_mode: string };
    expect(row.base_ref).toBe('develop');
    expect(row.deps_mode).toBe('inherited');
  });

  it('ignores .karst via .git/info/exclude WITHOUT touching tracked .gitignore', () => {
    const gitignoreBefore = readFileSync(join(repo.path, '.gitignore'), 'utf8');
    const treeBefore = git(repo.path, 'ls-files').trim();

    createWorktree(store, { ticketId: 1, repoPath: repo.path, slug: 'PROJ-1', baseRef: 'develop' });

    // tracked .gitignore unchanged
    expect(readFileSync(join(repo.path, '.gitignore'), 'utf8')).toBe(gitignoreBefore);
    // tracked file set unchanged (no new tracked files, .karst not committed)
    expect(git(repo.path, 'ls-files').trim()).toBe(treeBefore);
    // .git/info/exclude carries the rule
    const exclude = readFileSync(join(repo.path, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude).toMatch(/\.karst\//);
    // git status doesn't surface .karst as untracked
    const status = git(repo.path, 'status', '--porcelain');
    expect(status).not.toMatch(/\.karst/);
  });

  it('does not duplicate the exclude rule on a second worktree', () => {
    createWorktree(store, { ticketId: 1, repoPath: repo.path, slug: 'a', baseRef: 'develop' });
    createWorktree(store, { ticketId: 2, repoPath: repo.path, slug: 'b', baseRef: 'develop' });
    const exclude = readFileSync(join(repo.path, '.git', 'info', 'exclude'), 'utf8');
    const count = (exclude.match(/^\/\.karst\/$/gm) ?? []).length;
    expect(count).toBe(1);
  });

  it('removeWorktree cleans up the dir and releases the ticket\'s ports [L5]', () => {
    const alloc = makePortAllocator(store, [4000, 4999]);
    alloc.allocate(1, 'frontend', ['http']); // ports held by ticket 1
    const rec = createWorktree(store, { ticketId: 1, repoPath: repo.path, slug: 'x', baseRef: 'develop' });

    removeWorktree(store, rec, alloc);

    expect(existsSync(rec.path)).toBe(false);
    const wt = store.db.prepare('SELECT COUNT(*) AS n FROM worktrees WHERE ticket_id = 1').get() as { n: number };
    expect(wt.n).toBe(0);
    const ports = store.db.prepare('SELECT COUNT(*) AS n FROM port_allocations WHERE ticket_id = 1').get() as { n: number };
    expect(ports.n).toBe(0); // released
  });

  it('reinstallDeps flips deps_mode inherited -> local', () => {
    const rec = createWorktree(store, { ticketId: 1, repoPath: repo.path, slug: 'x', baseRef: 'develop' });
    expect(rec.depsMode).toBe('inherited');
    reinstallDeps(store, rec);
    const row = store.db
      .prepare('SELECT deps_mode FROM worktrees WHERE ticket_id = 1')
      .get() as { deps_mode: string };
    expect(row.deps_mode).toBe('local');
  });
});

describe('ticketIdForWorktreePath (symlink-invariant)', () => {
  it('resolves a realpath cwd against a raw stored worktree path', () => {
    const store = openStore(':memory:');
    // A ticket + a real worktree dir reached through a symlinked parent.
    store.db.prepare(
      `INSERT INTO tickets (id, key, title, source, stage_current)
       VALUES (1, 'K-1', 't', 'manual', 'impl')`,
    ).run();
    const realBase = realpathSync(mkdtempSync(join(tmpdir(), 'karst-wt-')));
    const link = join(realBase, 'link');
    const target = join(realBase, 'target');
    mkdirSync(target);
    // A directory junction on Windows, a symlink elsewhere. Windows reserves
    // real symlinks for elevated/developer-mode processes (EPERM otherwise), and
    // what this test needs is only that realpath resolves the parent away — which
    // a junction does identically.
    symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    const storedPath = join(link, 'wt'); // raw, symlinked — how createWorktree stores it
    mkdirSync(storedPath);
    store.db.prepare(
      `INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref, deps_mode)
       VALUES (1, ?, ?, 'karst/k-1', 'main', 'inherited')`,
    ).run(realBase, storedPath);

    // The hook reports the realpath-resolved cwd (git/Claude behavior).
    const hookCwd = realpathSync(storedPath);
    expect(ticketIdForWorktreePath(store, hookCwd)).toBe(1);

    store.close();
    rmSync(realBase, { recursive: true, force: true });
  });
});
