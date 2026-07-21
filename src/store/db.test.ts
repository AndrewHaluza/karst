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

  it('creates all 11 registry tables', () => {
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
      'INSERT INTO port_allocations (ticket_id, service, port_name, port) VALUES (?,?,?,?)',
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

  it('reports schema user_version 9', () => {
    const store = openStore(':memory:');
    cleanups.push(() => store.close());
    expect(store.db.pragma('user_version', { simple: true })).toBe(9);
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
    expect(migrated.db.pragma('user_version', { simple: true })).toBe(9);
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
    expect(migrated.db.pragma('user_version', { simple: true })).toBe(9);
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
    expect(migrated.db.pragma('user_version', { simple: true })).toBe(9);
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
    expect(migrated.db.pragma('user_version', { simple: true })).toBe(9);
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
    expect(migrated.db.pragma('user_version', { simple: true })).toBe(9);
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
    expect(migrated.db.pragma('user_version', { simple: true })).toBe(9);
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
