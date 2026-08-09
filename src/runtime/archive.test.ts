import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openStore, type Store } from '../store/db.js';
import { makePortAllocator } from '../resolver/allocator.js';
import { defaultGitRunner } from '../integrations/git.js';
import { createWorktree } from './worktree.js';
import { archiveWorktree, restoreWorktree } from './archive.js';
import { listArchives } from '../store/worktreeArchives.js';

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

/** True if `refName` resolves in `cwd` — unlike `git()`, does not throw on a missing ref. */
function refResolves(cwd: string, refName: string): boolean {
  const r = spawnSync('git', ['rev-parse', '--verify', '--quiet', refName], { cwd, encoding: 'utf8' });
  return r.status === 0;
}

function makeRepo(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'karst-arch-'));
  writeFileSync(join(dir, 'index.js'), 'console.log(1);\n');
  writeFileSync(join(dir, '.gitignore'), 'node_modules/\n');
  writeFileSync(join(dir, 'keep.txt'), 'original\n');
  git(dir, 'init', '-q', '-b', 'develop');
  git(dir, 'config', 'user.email', 'test@karst.local');
  git(dir, 'config', 'user.name', 'test');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
  return { path: dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('archive/restore worktree', () => {
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

  function spinWorktree() {
    const rec = createWorktree(store, {
      ticketId: 1,
      repoPath: repo.path,
      slug: 'K-9',
      baseRef: 'develop',
    });
    return rec;
  }

  it('archives uncommitted work into a ref, removes the folder, keeps the branch; restore brings everything back', async () => {
    const rec = spinWorktree();
    const alloc = makePortAllocator(store, [4000, 4100]);

    // Dirty the worktree: modify tracked, add untracked, delete tracked.
    writeFileSync(join(rec.path, 'index.js'), 'console.log(2);\n'); // modified
    writeFileSync(join(rec.path, 'new.txt'), 'brand new\n'); // untracked
    unlinkSync(join(rec.path, 'keep.txt')); // deletion

    const res = await archiveWorktree(defaultGitRunner, store, alloc, {
      ticketId: 1,
      repoPath: repo.path,
      path: rec.path,
      branch: rec.branch,
      baseRef: 'develop',
    });

    expect(res.outcome).toBe('archived');
    expect(res.archiveRef).toBe('refs/karst/archive/K-9');
    expect(existsSync(rec.path)).toBe(false); // folder reclaimed
    // branch survives in the parent repo
    expect(git(repo.path, 'rev-parse', '--verify', '--quiet', 'refs/heads/karst/K-9').trim()).not.toBe('');
    expect(listArchives(store, 1)).toHaveLength(1);

    // Restore
    const rr = await restoreWorktree(defaultGitRunner, store, { ticketId: 1, path: rec.path });
    expect(rr.outcome).toBe('restored');
    expect(existsSync(rec.path)).toBe(true);
    expect(readFileSync(join(rec.path, 'index.js'), 'utf8')).toBe('console.log(2);\n');
    expect(readFileSync(join(rec.path, 'new.txt'), 'utf8')).toBe('brand new\n');
    expect(existsSync(join(rec.path, 'keep.txt'))).toBe(false);
    // changes come back UNSTAGED
    expect(git(rec.path, 'status', '--porcelain')).not.toBe('');
    // ref + row cleared
    expect(refResolves(repo.path, 'refs/karst/archive/K-9')).toBe(false);
    expect(listArchives(store, 1)).toHaveLength(0);
  });

  // A templated branch may carry slashes of its own (`karst/feat/<slug>`). The
  // Archiving removes the tree out from under whatever was running in it. The
  // caller owns the output channel, so the result has to CARRY what was stopped
  // — a reap nothing reports is the invisibility this fix exists to end
  // (869ed2n50: two ~1 GB dev servers, three days, nothing on any surface).
  it('carries the servers it had to stop out to the caller', async () => {
    const rec = spinWorktree();
    const alloc = makePortAllocator(store, [4000, 4100]);
    store.db
      .prepare(
        `INSERT INTO servers (ticket_id, repo, host, port, pid, status, log_path, cwd)
         VALUES (1, 'frontend', 'localhost', 3005, NULL, 'running', '/l', ?)`,
      )
      .run(rec.path);

    const res = await archiveWorktree(defaultGitRunner, store, alloc, {
      ticketId: 1,
      repoPath: repo.path,
      path: rec.path,
      branch: rec.branch,
      baseRef: 'develop',
    });

    expect(res.reapedServers.map((s) => [s.repo, s.cwd, s.reason])).toEqual([
      ['frontend', rec.path, 'worktree-removed'],
    ]);
  });

  // The v21 step was renumbered before release (it once numbered the gate_runs
  // columns), so a registry stamped by the older build reports user_version 22
  // while `servers` never gained `cwd` — and the archive's pre-removal server
  // scan `SELECT … cwd FROM servers` then crashed the whole operation with
  // "no such column: cwd" (869efu319). The open must REPAIR that shape wherever
  // the version gate has already passed, and the archive must then complete —
  // leaving the legacy row alone: a NULL cwd reads as "unknown", never as
  // "under this worktree".
  it('archives successfully on a pre-fix DB whose servers table never gained cwd', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-arch-'));
    const dbPath = join(dir, 'karst.db');
    // Build the pre-v21 schema: `current = 22` so `openStore`'s v1 step
    // (CREATE TABLE IF NOT EXISTS) is skipped and only v22+ migrations run.
    // Every table the archive path and the migration path touch must exist.
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE tickets (
        id INTEGER PRIMARY KEY, key TEXT NOT NULL, title TEXT NOT NULL,
        source TEXT, description TEXT, brief TEXT, source_ref TEXT,
        source_fetched_at TEXT, approach TEXT, selected_repos TEXT,
        archived_at TEXT, agent TEXT, model TEXT, project_id INTEGER,
        agent_provider TEXT, session_provider TEXT, parent_ticket_id INTEGER,
        type TEXT, disabled_gates TEXT, stage_current TEXT NOT NULL DEFAULT 'impl'
      );
      CREATE TABLE stages (
        ticket_id INTEGER NOT NULL, stage_key TEXT NOT NULL, status TEXT NOT NULL,
        attempt INTEGER NOT NULL, blocked_kind TEXT, blocked_reason TEXT,
        blocked_at TEXT, started_at TEXT, ended_at TEXT,
        PRIMARY KEY (ticket_id, stage_key)
      );
      CREATE TABLE gate_runs (
        id INTEGER PRIMARY KEY, ticket_id INTEGER NOT NULL, stage_key TEXT NOT NULL,
        attempt INTEGER NOT NULL, run_at TEXT NOT NULL, gate_name TEXT NOT NULL,
        exit_code INTEGER, started_at TEXT, ended_at TEXT
      );
      CREATE TABLE servers (
        id INTEGER PRIMARY KEY, ticket_id INTEGER, repo TEXT NOT NULL, host TEXT,
        port INTEGER, pid INTEGER, status TEXT NOT NULL, log_path TEXT,
        started_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE port_allocations (
        ticket_id INTEGER NOT NULL, repo TEXT NOT NULL, port_name TEXT NOT NULL,
        port INTEGER NOT NULL, UNIQUE (port)
      );
      CREATE TABLE worktrees (
        ticket_id INTEGER NOT NULL, repo TEXT NOT NULL, path TEXT NOT NULL,
        branch TEXT, base_ref TEXT, deps_mode TEXT NOT NULL DEFAULT 'inherited',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE worktree_archives (
        id INTEGER PRIMARY KEY, ticket_id INTEGER NOT NULL, repo TEXT NOT NULL,
        path TEXT NOT NULL, branch TEXT NOT NULL, base_ref TEXT,
        archive_ref TEXT NOT NULL, method TEXT NOT NULL, reclaimed_bytes INTEGER,
        archived_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    legacy.prepare('INSERT INTO tickets (id, key, title) VALUES (?, ?, ?)').run(1, 'K-9', 'test');
    // user_version 22: exactly what the pre-renumbering build stamped (its
    // SCHEMA_VERSION was 22; its v21 ran the gate_runs columns, not servers.cwd).
    legacy.pragma('user_version = 22');
    // Insert a running server row BEFORE migration, WITHOUT cwd — exactly the
    // shape a pre-renumbering build left behind. The path is a string in the DB;
    // the directory doesn't need to exist yet.
    legacy
      .prepare(
        "INSERT INTO servers (ticket_id, repo, host, port, pid, status, log_path) VALUES (1,'frontend','localhost',3005,NULL,'running','/l')",
      )
      .run();
    legacy.close();

    const store = openStore(dbPath);
    const alloc = makePortAllocator(store, [4000, 4100]);
    const rec = createWorktree(store, {
      ticketId: 1,
      repoPath: repo.path,
      slug: 'K-9',
      baseRef: 'develop',
    });
    writeFileSync(join(rec.path, 'index.js'), 'console.log(2);\n');

    const res = await archiveWorktree(defaultGitRunner, store, alloc, {
      ticketId: 1,
      repoPath: repo.path,
      path: rec.path,
      branch: rec.branch,
      baseRef: 'develop',
    });

    // The migration repaired the missing column before the archive ran…
    const cols = new Set(
      (store.db.prepare("PRAGMA table_info('servers')").all() as { name: string }[]).map(
        (c) => c.name,
      ),
    );
    expect(cols.has('cwd')).toBe(true);
    // …the archive completed with no data loss…
    expect(res.outcome).toBe('archived');
    expect(res.archiveRef).toBe('refs/karst/archive/K-9');
    expect(existsSync(rec.path)).toBe(false);
    expect(listArchives(store, 1)).toHaveLength(1);
    // …and the pre-v21 row was left alone: NULL cwd is "unknown", never reaped
    // on a guess, and certainly not a reason for the archive to fail.
    expect(res.reapedServers).toEqual([]);
    expect(
      store.db.prepare('SELECT status, cwd FROM servers WHERE ticket_id = 1').get(),
    ).toEqual({ status: 'running', cwd: null });

    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports no servers when the archive was skipped, rather than omitting the field', async () => {
    const alloc = makePortAllocator(store, [4000, 4100]);
    const res = await archiveWorktree(defaultGitRunner, store, alloc, {
      ticketId: 1,
      repoPath: repo.path,
      path: join(repo.path, '.karst', 'worktrees', 'never-existed'),
      branch: 'karst/never',
      baseRef: 'develop',
    });

    expect(res.outcome).toBe('skipped');
    expect(res.reapedServers).toEqual([]);
  });

  // archive slug comes from the worktree PATH, not from stripping a `karst/`
  // prefix off the branch, so the ref stays flat and restore reuses the stored
  // branch verbatim instead of re-deriving it.
  it('round-trips a templated branch whose name carries extra slashes', async () => {
    const rec = createWorktree(store, {
      ticketId: 2,
      repoPath: repo.path,
      slug: 'K-7',
      branch: 'karst/feat/k-7-add-search',
      baseRef: 'develop',
    });
    expect(rec.branch).toBe('karst/feat/k-7-add-search');
    const alloc = makePortAllocator(store, [4000, 4100]);
    writeFileSync(join(rec.path, 'index.js'), 'console.log(3);\n');

    const res = await archiveWorktree(defaultGitRunner, store, alloc, {
      ticketId: 2,
      repoPath: repo.path,
      path: rec.path,
      branch: rec.branch,
      baseRef: 'develop',
    });
    expect(res.outcome).toBe('archived');
    expect(res.archiveRef).toBe('refs/karst/archive/K-7');

    const rr = await restoreWorktree(defaultGitRunner, store, { ticketId: 2, path: rec.path });
    expect(rr.outcome).toBe('restored');
    expect(readFileSync(join(rec.path, 'index.js'), 'utf8')).toBe('console.log(3);\n');
    // Restored onto the SAME branch — no second branch was invented.
    expect(git(rec.path, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe(
      'karst/feat/k-7-add-search',
    );
    expect(listArchives(store, 2)).toHaveLength(0);
  });

  it('with no uncommitted changes, records an empty ref and restore recreates a clean worktree', async () => {
    const rec = spinWorktree();
    const alloc = makePortAllocator(store, [4000, 4100]);

    const res = await archiveWorktree(defaultGitRunner, store, alloc, {
      ticketId: 1,
      repoPath: repo.path,
      path: rec.path,
      branch: rec.branch,
      baseRef: 'develop',
    });
    expect(res.outcome).toBe('archived');
    expect(res.archiveRef).toBe('');
    expect(existsSync(rec.path)).toBe(false);

    const rr = await restoreWorktree(defaultGitRunner, store, { ticketId: 1, path: rec.path });
    expect(rr.outcome).toBe('restored');
    expect(existsSync(rec.path)).toBe(true);
    expect(git(rec.path, 'status', '--porcelain')).toBe('');
  });

  it('skips an orphan folder (folder present but not a registered worktree)', async () => {
    const orphan = join(repo.path, 'not-a-worktree');
    mkdtempSync(join(tmpdir(), 'ignore-')); // noop to keep imports honest
    writeFileSync(join(repo.path, 'placeholder'), 'x'); // ensure repo writable
    const alloc = makePortAllocator(store, [4000, 4100]);
    // Create a bare folder that is not a git worktree.
    rmSync(orphan, { recursive: true, force: true });
    writeFileSync(join(repo.path, 'orphan-marker'), 'x');
    const res = await archiveWorktree(defaultGitRunner, store, alloc, {
      ticketId: 1,
      repoPath: repo.path,
      path: join(repo.path, 'orphan-marker-dir-does-not-exist'),
      branch: 'karst/none',
      baseRef: 'develop',
    });
    expect(res.outcome).toBe('skipped');
  });
});
