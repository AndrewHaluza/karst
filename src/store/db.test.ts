import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openStore, type Store } from './db.js';

const EXPECTED_TABLES = [
  'projects',
  'tickets',
  'stages',
  'gate_runs',
  'phase_marks',
  'worktrees',
  'port_allocations',
  'baseline_refs',
  'servers',
  'prs',
  'merge_checks',
  'worktree_archives',
] as const;

function tableNames(store: Store): string[] {
  return store.db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    )
    .all()
    .map((r) => (r as { name: string }).name);
}

describe('openStore', () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  it('creates all 12 registry tables', () => {
    const store = openStore(':memory:');
    cleanups.push(() => store.close());
    const names = tableNames(store);
    for (const t of EXPECTED_TABLES) {
      expect(names, `missing table: ${t}`).toContain(t);
    }
    expect(names).toHaveLength(EXPECTED_TABLES.length);
  });

  it('does NOT create a deferred events table (dropped for MVP)', () => {
    const store = openStore(':memory:');
    cleanups.push(() => store.close());
    expect(tableNames(store)).not.toContain('events');
  });

  it('enforces UNIQUE(port) on port_allocations', () => {
    const store = openStore(':memory:');
    cleanups.push(() => store.close());
    const insert = store.db.prepare(
      'INSERT INTO port_allocations (ticket_id, repo, port_name, port) VALUES (?,?,?,?)',
    );
    insert.run(1, 'frontend', 'PORT', 47201);
    expect(() => insert.run(2, 'backend', 'PORT', 47201)).toThrow(/UNIQUE/i);
  });

  it('enables WAL journal mode for on-disk DBs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-db-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const store = openStore(join(dir, 'karst.db'));
    cleanups.push(() => store.close());
    const mode = (
      store.db.pragma('journal_mode', { simple: true }) as string
    ).toLowerCase();
    expect(mode).toBe('wal');
  });

  it('tickets carries the v2 onboarding columns', () => {
    const store = openStore(':memory:');
    cleanups.push(() => store.close());
    const cols = store.db
      .prepare("PRAGMA table_info('tickets')")
      .all()
      .map((r) => (r as { name: string }).name);
    for (const c of [
      'description',
      'brief',
      'source_ref',
      'source_fetched_at',
      'approach',
      'selected_repos',
    ]) {
      expect(cols, `missing ticket column: ${c}`).toContain(c);
    }
  });

  it('tickets carries the v3 archived_at column', () => {
    const store = openStore(':memory:');
    cleanups.push(() => store.close());
    const cols = store.db
      .prepare("PRAGMA table_info('tickets')")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(cols).toContain('archived_at');
  });

  it('reports the current schema user_version', () => {
    const store = openStore(':memory:');
    cleanups.push(() => store.close());
    expect(store.db.pragma('user_version', { simple: true })).toBe(16);
  });

  it('tickets carries the v4 agent column', () => {
    const store = openStore(':memory:');
    cleanups.push(() => store.close());
    const cols = store.db
      .prepare("PRAGMA table_info('tickets')")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(cols).toContain('agent');
  });

  it('tickets carries the v5 model column', () => {
    const store = openStore(':memory:');
    cleanups.push(() => store.close());
    const cols = store.db
      .prepare("PRAGMA table_info('tickets')")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(cols).toContain('model');
  });

  it('tickets carries the v12 agent_provider column', () => {
    const store = openStore(':memory:');
    cleanups.push(() => store.close());
    const cols = store.db
      .prepare("PRAGMA table_info('tickets')")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(cols).toContain('agent_provider');
  });

  it('tickets carries the v14 parent_ticket_id column', () => {
    const store = openStore(':memory:');
    cleanups.push(() => store.close());
    const cols = store.db
      .prepare("PRAGMA table_info('tickets')")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(cols).toContain('parent_ticket_id');
  });

  it('tickets carries the v15 type column', () => {
    const store = openStore(':memory:');
    cleanups.push(() => store.close());
    const cols = store.db
      .prepare("PRAGMA table_info('tickets')")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(cols).toContain('type');
  });

  it('prs carries the v16 PR metadata columns', () => {
    const store = openStore(':memory:');
    cleanups.push(() => store.close());
    const cols = store.db
      .prepare("PRAGMA table_info('prs')")
      .all()
      .map((r) => (r as { name: string }).name);
    for (const col of ['head_ref', 'base_ref', 'created_at', 'merged_at', 'comments']) {
      expect(cols, `missing prs column: ${col}`).toContain(col);
    }
  });

  it('migrates a v15 DB to v16, adding the prs metadata columns without touching rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-db-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'karst.db');
    const legacy = new Database(path);
    legacy.exec(
      'CREATE TABLE prs (ticket_id INTEGER NOT NULL, repo TEXT NOT NULL, number INTEGER, url TEXT, status TEXT)',
    );
    legacy
      .prepare('INSERT INTO prs (ticket_id, repo, number, url, status) VALUES (?, ?, ?, ?, ?)')
      .run(7, '/repo/a', 12, 'https://github.com/o/r/pull/12', 'open');
    legacy.pragma('user_version = 15');
    legacy.close();

    const migrated = openStore(path);
    cleanups.push(() => migrated.close());
    const row = migrated.db
      .prepare('SELECT number, status, head_ref, base_ref, created_at, merged_at, comments FROM prs')
      .get() as Record<string, unknown> | undefined;
    // Nothing is backfilled: a pre-v16 row carries no branch/date/comment facts to
    // derive, and NULL reads as "never probed" — the next PR sweep fills them.
    expect(row).toEqual({
      number: 12,
      status: 'open',
      head_ref: null,
      base_ref: null,
      created_at: null,
      merged_at: null,
      comments: null,
    });
    expect(migrated.db.pragma('user_version', { simple: true })).toBe(16);
  });

  it('migrates a v14 DB to v15, adding tickets.type without touching rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-db-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'karst.db');
    const legacy = new Database(path);
    legacy.exec(
      'CREATE TABLE tickets (id INTEGER PRIMARY KEY, key TEXT, title TEXT, model TEXT, project_id INTEGER)',
    );
    legacy.prepare('INSERT INTO tickets (key, title) VALUES (?, ?)').run('K-1', 'keep me');
    legacy.pragma('user_version = 14');
    legacy.close();

    const migrated = openStore(path);
    cleanups.push(() => migrated.close());
    const row = migrated.db
      .prepare('SELECT key, title, type FROM tickets WHERE key = ?')
      .get('K-1') as { key: string; title: string; type: string | null } | undefined;
    // Nothing is backfilled: a pre-v15 ticket has no conventional type to derive,
    // so it stays NULL and renders as the manifest default.
    expect(row).toEqual({ key: 'K-1', title: 'keep me', type: null });
    expect(migrated.db.pragma('user_version', { simple: true })).toBe(16);
  });

  it('migrates a legacy v13 DB to v14, adding the parent_ticket_id column', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-db-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'karst.db');
    const legacy = new Database(path);
    legacy.exec(
      "CREATE TABLE tickets (id INTEGER PRIMARY KEY, key TEXT, title TEXT, source TEXT, stage_current TEXT, agent_state TEXT, session_id TEXT, description TEXT, brief TEXT, source_ref TEXT, source_fetched_at TEXT, approach TEXT, agent TEXT, selected_repos TEXT, archived_at TEXT, model TEXT, agent_provider TEXT, session_provider TEXT, project_id INTEGER, created_at TEXT, updated_at TEXT)",
    );
    legacy.prepare('INSERT INTO tickets (key, title) VALUES (?, ?)').run('OLD-13', 'v13 row');
    legacy.pragma('user_version = 13');
    legacy.close();

    const migrated = openStore(path);
    cleanups.push(() => migrated.close());
    const cols = migrated.db
      .prepare("PRAGMA table_info('tickets')")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(cols).toContain('parent_ticket_id');
    const row = migrated.db
      .prepare('SELECT title, parent_ticket_id FROM tickets WHERE key = ?')
      .get('OLD-13') as { title: string; parent_ticket_id: number | null } | undefined;
    expect(row?.title).toBe('v13 row'); // data survived
    expect(row?.parent_ticket_id).toBeNull(); // nothing to backfill: not a follow-up
    expect(migrated.db.pragma('user_version', { simple: true })).toBe(16);
  });

  it('tickets carries the v13 session_provider column', () => {
    const store = openStore(':memory:');
    cleanups.push(() => store.close());
    const cols = store.db
      .prepare("PRAGMA table_info('tickets')")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(cols).toContain('session_provider');
  });

  it('migrates a legacy v12 DB to v13, adding session_provider and leaving old sessions untagged', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-db-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'karst.db');
    const legacy = new Database(path);
    legacy.exec(
      "CREATE TABLE tickets (id INTEGER PRIMARY KEY, key TEXT, title TEXT, source TEXT, stage_current TEXT, agent_state TEXT, session_id TEXT, description TEXT, brief TEXT, source_ref TEXT, source_fetched_at TEXT, approach TEXT, agent TEXT, selected_repos TEXT, archived_at TEXT, model TEXT, agent_provider TEXT, project_id INTEGER, created_at TEXT, updated_at TEXT)",
    );
    legacy
      .prepare('INSERT INTO tickets (key, title, session_id) VALUES (?, ?, ?)')
      .run('OLD-12', 'v12 row', 'sess-from-v12');
    legacy.pragma('user_version = 12');
    legacy.close();

    const migrated = openStore(path);
    cleanups.push(() => migrated.close());
    const cols = migrated.db
      .prepare("PRAGMA table_info('tickets')")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(cols).toContain('session_provider');
    // The provider of an already-captured session cannot be derived, so the
    // migration must not guess one — an untagged session is simply never resumed.
    const row = migrated.db
      .prepare('SELECT title, session_id, session_provider FROM tickets WHERE key = ?')
      .get('OLD-12') as
      | { title: string; session_id: string | null; session_provider: string | null }
      | undefined;
    expect(row?.title).toBe('v12 row'); // data survived
    expect(row?.session_id).toBe('sess-from-v12');
    expect(row?.session_provider).toBeNull();
    expect(migrated.db.pragma('user_version', { simple: true })).toBe(16);
  });

  it('migrates a legacy v11 DB to v12, adding the agent_provider column', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-db-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'karst.db');
    const legacy = new Database(path);
    legacy.exec(
      "CREATE TABLE tickets (id INTEGER PRIMARY KEY, key TEXT, title TEXT, source TEXT, stage_current TEXT, agent_state TEXT, session_id TEXT, description TEXT, brief TEXT, source_ref TEXT, source_fetched_at TEXT, approach TEXT, agent TEXT, selected_repos TEXT, archived_at TEXT, model TEXT, project_id INTEGER, created_at TEXT, updated_at TEXT)",
    );
    legacy.prepare('INSERT INTO tickets (key, title) VALUES (?, ?)').run('OLD-11', 'v11 row');
    legacy.pragma('user_version = 11');
    legacy.close();

    const migrated = openStore(path);
    cleanups.push(() => migrated.close());
    const cols = migrated.db
      .prepare("PRAGMA table_info('tickets')")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(cols).toContain('agent_provider');
    const row = migrated.db
      .prepare('SELECT title FROM tickets WHERE key = ?')
      .get('OLD-11') as { title: string } | undefined;
    expect(row?.title).toBe('v11 row'); // data survived
    expect(migrated.db.pragma('user_version', { simple: true })).toBe(16);
  });

  it('migrates a legacy v4 DB to v5, adding the model column', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-db-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'karst.db');
    const legacy = new Database(path);
    legacy.exec(
      "CREATE TABLE tickets (id INTEGER PRIMARY KEY, key TEXT, title TEXT, source TEXT, stage_current TEXT, agent_state TEXT, session_id TEXT, description TEXT, brief TEXT, source_ref TEXT, source_fetched_at TEXT, approach TEXT, agent TEXT, selected_repos TEXT, archived_at TEXT, created_at TEXT, updated_at TEXT)",
    );
    legacy.prepare('INSERT INTO tickets (key, title) VALUES (?, ?)').run('OLD-4', 'v4 row');
    legacy.pragma('user_version = 4');
    legacy.close();

    const migrated = openStore(path);
    cleanups.push(() => migrated.close());
    const cols = migrated.db
      .prepare("PRAGMA table_info('tickets')")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(cols).toContain('model');
    const row = migrated.db
      .prepare('SELECT title FROM tickets WHERE key = ?')
      .get('OLD-4') as { title: string } | undefined;
    expect(row?.title).toBe('v4 row'); // data survived
    expect(migrated.db.pragma('user_version', { simple: true })).toBe(16);
  });

  it('migrates a v5 DB to v6, adding projects + project_id and leaving rows unassigned', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-db-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'karst.db');
    const legacy = new Database(path);
    legacy.exec(
      "CREATE TABLE tickets (id INTEGER PRIMARY KEY, key TEXT, title TEXT, source TEXT, stage_current TEXT, agent_state TEXT, session_id TEXT, description TEXT, brief TEXT, source_ref TEXT, source_fetched_at TEXT, approach TEXT, agent TEXT, selected_repos TEXT, archived_at TEXT, model TEXT, created_at TEXT, updated_at TEXT)",
    );
    legacy.prepare('INSERT INTO tickets (key, title) VALUES (?, ?)').run('OLD-5', 'v5 row');
    legacy.pragma('user_version = 5');
    legacy.close();

    const migrated = openStore(path);
    cleanups.push(() => migrated.close());
    expect(tableNames(migrated)).toContain('projects');
    const cols = migrated.db
      .prepare("PRAGMA table_info('tickets')")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(cols).toContain('project_id');

    // The migration must NOT guess an owner — it has no way to know one. The
    // row survives unassigned, for the host to adopt on first project bind.
    const row = migrated.db
      .prepare('SELECT title, project_id FROM tickets WHERE key = ?')
      .get('OLD-5') as { title: string; project_id: number | null } | undefined;
    expect(row?.title).toBe('v5 row');
    expect(row?.project_id).toBeNull();
    expect(migrated.db.pragma('user_version', { simple: true })).toBe(16);
  });

  it('migrates a v6 DB to v7, adding gate_runs without touching stages', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-db-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'karst.db');
    const legacy = new Database(path);
    legacy.exec(
      'CREATE TABLE stages (ticket_id INTEGER NOT NULL, stage_key TEXT NOT NULL, status TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0, verdict TEXT, artifact_path TEXT, started_at TEXT, ended_at TEXT, PRIMARY KEY (ticket_id, stage_key))',
    );
    legacy
      .prepare('INSERT INTO stages (ticket_id, stage_key, status, verdict) VALUES (?, ?, ?, ?)')
      .run(1, 'review', 'failed', 'gates failed: lint');
    legacy.pragma('user_version = 6');
    legacy.close();

    const migrated = openStore(path);
    cleanups.push(() => migrated.close());
    expect(tableNames(migrated)).toContain('gate_runs');

    // The stage row is left exactly as it was: the migration is additive only.
    const row = migrated.db
      .prepare('SELECT status, verdict FROM stages WHERE ticket_id = ? AND stage_key = ?')
      .get(1, 'review') as { status: string; verdict: string } | undefined;
    expect(row).toEqual({ status: 'failed', verdict: 'gates failed: lint' });

    // Nothing is backfilled — past gate results are unrecoverable, and guessing
    // them would be the inference the no-inference guarantee forbids.
    const runs = migrated.db.prepare('SELECT * FROM gate_runs').all();
    expect(runs).toEqual([]);
    expect(migrated.db.pragma('user_version', { simple: true })).toBe(16);
  });

  it('migrates a v7 DB to v8, adding phase_marks without touching stages', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-db-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'karst.db');
    const legacy = new Database(path);
    legacy.exec(
      'CREATE TABLE stages (ticket_id INTEGER NOT NULL, stage_key TEXT NOT NULL, status TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0, verdict TEXT, artifact_path TEXT, started_at TEXT, ended_at TEXT, PRIMARY KEY (ticket_id, stage_key))',
    );
    legacy
      .prepare('INSERT INTO stages (ticket_id, stage_key, status, attempt) VALUES (?, ?, ?, ?)')
      .run(1, 'impl', 'running', 2);
    legacy.pragma('user_version = 7');
    legacy.close();

    const migrated = openStore(path);
    cleanups.push(() => migrated.close());
    expect(tableNames(migrated)).toContain('phase_marks');

    // The stage row is left exactly as it was: the migration is additive only.
    const row = migrated.db
      .prepare('SELECT status, attempt FROM stages WHERE ticket_id = ? AND stage_key = ?')
      .get(1, 'impl') as { status: string; attempt: number } | undefined;
    expect(row).toEqual({ status: 'running', attempt: 2 });

    // Nothing is backfilled — there is no record of past phase activity, and
    // inventing marks would be exactly the inference karst forbids.
    const marks = migrated.db.prepare('SELECT * FROM phase_marks').all();
    expect(marks).toEqual([]);
    expect(migrated.db.pragma('user_version', { simple: true })).toBe(16);
  });

  it('migrates a v8 DB to v9, adding merge_checks without touching prs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-db-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'karst.db');
    const legacy = new Database(path);
    legacy.exec(
      'CREATE TABLE prs (ticket_id INTEGER NOT NULL, repo TEXT NOT NULL, number INTEGER, url TEXT, status TEXT)',
    );
    legacy
      .prepare('INSERT INTO prs (ticket_id, repo, number, url, status) VALUES (?, ?, ?, ?, ?)')
      .run(1, 'web', 42, 'https://example.test/pr/42', 'open');
    legacy.pragma('user_version = 8');
    legacy.close();

    const migrated = openStore(path);
    cleanups.push(() => migrated.close());
    expect(tableNames(migrated)).toContain('merge_checks');

    // The PR row is left exactly as it was: the migration is additive only.
    const row = migrated.db
      .prepare('SELECT number, status FROM prs WHERE ticket_id = ? AND repo = ?')
      .get(1, 'web') as { number: number; status: string } | undefined;
    expect(row).toEqual({ number: 42, status: 'open' });

    // Nothing is backfilled, and nothing could be: mergeability is a property of
    // two refs that have both moved since. An already-shipped ticket shows no
    // merge check until its next ship — never a manufactured "clean".
    const checks = migrated.db.prepare('SELECT * FROM merge_checks').all();
    expect(checks).toEqual([]);
    expect(migrated.db.pragma('user_version', { simple: true })).toBe(16);
  });

  // v10 is the first NON-additive step: a column rename. The values never
  // changed meaning (they were always manifest keys), so nothing is backfilled —
  // but existing rows must survive intact, which is what this proves.
  it('migrates a v9 DB to v10, renaming service -> repo and preserving rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-db-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'karst.db');
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE servers (
        id INTEGER PRIMARY KEY, ticket_id INTEGER, service TEXT NOT NULL,
        host TEXT, port INTEGER, pid INTEGER, status TEXT NOT NULL, log_path TEXT,
        started_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE port_allocations (
        ticket_id INTEGER NOT NULL, service TEXT NOT NULL,
        port_name TEXT NOT NULL, port INTEGER NOT NULL, UNIQUE (port)
      );
      CREATE TABLE baseline_refs (
        ticket_id INTEGER NOT NULL, service TEXT NOT NULL,
        PRIMARY KEY (ticket_id, service)
      );
    `);
    legacy
      .prepare("INSERT INTO servers (ticket_id, service, host, port, status) VALUES (1,'api','h',3000,'running')")
      .run();
    legacy.prepare("INSERT INTO port_allocations VALUES (1,'api','http',4000)").run();
    legacy.prepare("INSERT INTO baseline_refs VALUES (1,'api')").run();
    legacy.pragma('user_version = 9');
    legacy.close();

    const migrated = openStore(path);
    cleanups.push(() => migrated.close());

    for (const table of ['servers', 'port_allocations', 'baseline_refs']) {
      const cols = new Set(
        (migrated.db.prepare(`PRAGMA table_info('${table}')`).all() as { name: string }[])
          .map((c) => c.name),
      );
      expect(cols.has('repo')).toBe(true);
      expect(cols.has('service')).toBe(false);
    }

    // Every row survived the rename with its value intact.
    expect(
      migrated.db.prepare('SELECT repo, port, status FROM servers WHERE ticket_id = 1').get(),
    ).toEqual({ repo: 'api', port: 3000, status: 'running' });
    expect(
      migrated.db.prepare('SELECT repo, port FROM port_allocations WHERE ticket_id = 1').get(),
    ).toEqual({ repo: 'api', port: 4000 });
    expect(
      migrated.db.prepare('SELECT repo FROM baseline_refs WHERE ticket_id = 1').get(),
    ).toEqual({ repo: 'api' });

    expect(migrated.db.pragma('user_version', { simple: true })).toBe(16);
  });

  // The rename step is guarded on the CURRENT columns, so re-running it (a fresh
  // DB, or a second open) must be a no-op rather than an error.
  it('is a no-op on a fresh DB, which already has repo columns', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-db-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'karst.db');

    const first = openStore(path);
    first.db.prepare("INSERT INTO baseline_refs (ticket_id, repo) VALUES (1,'api')").run();
    first.close();

    const reopened = openStore(path); // migrate() runs again
    cleanups.push(() => reopened.close());
    expect(
      reopened.db.prepare('SELECT repo FROM baseline_refs WHERE ticket_id = 1').get(),
    ).toEqual({ repo: 'api' });
    expect(reopened.db.pragma('user_version', { simple: true })).toBe(16);
  });

  it('migrates a v10 DB to v11, adding worktree_archives', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-db-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'karst.db');
    const legacy = new Database(path);
    legacy.exec(
      "CREATE TABLE worktrees (ticket_id INTEGER NOT NULL, repo TEXT NOT NULL, path TEXT NOT NULL, branch TEXT, base_ref TEXT, deps_mode TEXT NOT NULL DEFAULT 'inherited', created_at TEXT)",
    );
    legacy
      .prepare(
        "INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref) VALUES (?, ?, ?, ?, ?)",
      )
      .run(1, '/repo', '/repo/.karst/worktrees/K-1', 'karst/K-1', 'main');
    legacy.pragma('user_version = 10');
    legacy.close();

    const migrated = openStore(path);
    cleanups.push(() => migrated.close());
    expect(tableNames(migrated)).toContain('worktree_archives');

    // The worktrees row is left exactly as it was: the migration is additive only.
    const row = migrated.db
      .prepare('SELECT repo, branch FROM worktrees WHERE ticket_id = ?')
      .get(1) as { repo: string; branch: string } | undefined;
    expect(row).toEqual({ repo: '/repo', branch: 'karst/K-1' });

    // Nothing is backfilled — an archive is a git ref that only exists once a
    // worktree is actually archived; there is nothing to derive here.
    const archives = migrated.db.prepare('SELECT * FROM worktree_archives').all();
    expect(archives).toEqual([]);
    expect(migrated.db.pragma('user_version', { simple: true })).toBe(16);
  });

  it('enforces UNIQUE(slug) on projects', () => {
    const store = openStore(':memory:');
    cleanups.push(() => store.close());
    const insert = store.db.prepare('INSERT INTO projects (slug, name) VALUES (?, ?)');
    insert.run('karst', 'Karst');
    expect(() => insert.run('karst', 'Karst again')).toThrow(/UNIQUE/i);
  });

  it('migrates a v2 DB to v3, adding archived_at and preserving rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-db-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'karst.db');

    // Simulate a legacy v2 DB (onboarding columns present, no archived_at).
    const legacy = new Database(path);
    legacy.exec(
      "CREATE TABLE tickets (id INTEGER PRIMARY KEY, key TEXT, title TEXT, source TEXT, stage_current TEXT, agent_state TEXT, session_id TEXT, description TEXT, brief TEXT, source_ref TEXT, source_fetched_at TEXT, approach TEXT, selected_repos TEXT, created_at TEXT, updated_at TEXT)",
    );
    legacy.prepare('INSERT INTO tickets (key, title) VALUES (?, ?)').run('OLD-2', 'v2 row');
    legacy.pragma('user_version = 2');
    legacy.close();

    const migrated = openStore(path);
    cleanups.push(() => migrated.close());
    const cols = migrated.db
      .prepare("PRAGMA table_info('tickets')")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(cols).toContain('archived_at');
    const row = migrated.db
      .prepare('SELECT title FROM tickets WHERE key = ?')
      .get('OLD-2') as { title: string } | undefined;
    expect(row?.title).toBe('v2 row'); // data survived
    expect(migrated.db.pragma('user_version', { simple: true })).toBe(16);
  });

  it('migrates a v1 DB to v2, adding columns and preserving rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-db-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'karst.db');

    // Simulate a legacy v1 DB: v1 schema shape, user_version pinned to 1.
    const legacy = new Database(path);
    legacy.exec(
      "CREATE TABLE tickets (id INTEGER PRIMARY KEY, key TEXT, title TEXT, source TEXT, stage_current TEXT, agent_state TEXT, session_id TEXT, created_at TEXT, updated_at TEXT)",
    );
    legacy.prepare('INSERT INTO tickets (key, title) VALUES (?, ?)').run('OLD-1', 'legacy');
    legacy.pragma('user_version = 1');
    legacy.close();

    const migrated = openStore(path);
    cleanups.push(() => migrated.close());
    const cols = migrated.db
      .prepare("PRAGMA table_info('tickets')")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(cols).toContain('brief');
    const row = migrated.db
      .prepare('SELECT title FROM tickets WHERE key = ?')
      .get('OLD-1') as { title: string } | undefined;
    expect(row?.title).toBe('legacy'); // data survived the migration
  });

  it('is idempotent when reopening an existing DB', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-db-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'karst.db');

    const first = openStore(path);
    first.db
      .prepare('INSERT INTO tickets (key, title) VALUES (?, ?)')
      .run('PROJ-1', 'seed');
    first.close();

    const second = openStore(path);
    cleanups.push(() => second.close());
    expect(tableNames(second)).toHaveLength(EXPECTED_TABLES.length);
    const row = second.db
      .prepare('SELECT key FROM tickets WHERE key = ?')
      .get('PROJ-1') as { key: string } | undefined;
    expect(row?.key).toBe('PROJ-1'); // data survived, no re-init wiped it
  });
});
