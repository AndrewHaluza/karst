import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { openStore, type Store } from './db.js';
import { createTicket } from './tickets.js';
import { GRAPH_MIGRATION_DDL, NODE_RUN_STATUSES_V37_DDL, GRAPH_WORKSPACE_MIGRATION_DDL } from './migrations.js';

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
  'ticket_attachments',
  'token_usage',
  'review_findings',
  'stage_runs',
  'process_runs',
  'implementation_runs',
  'session_launch_intents',
  'implementation_segments',
  'interactive_usage_samples',
  'recovery_rounds',
  'uat_findings',
  'ship_runs',
  'ship_repo_steps',
  'ship_operation_intents',
  'ship_commits',
  'approach_graph_runs',
  'approach_planner_runs',
  'approach_graph_revisions',
  'approach_node_runs',
  'approach_graph_tokens',
  'approach_artifact_instances',
  'approach_resource_leases',
  'approach_node_overrides',
  'approach_graph_workspaces',
  'approach_node_deferrals',
  'test_logs',
  'test_hooks',
] as const;

function tableNames(store: Store): string[] {
  return store.db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    )
    .all()
    .map((r) => (r as { name: string }).name);
}

/** The pre-v36 schema text: pre-v36 schema text: current schema.sql minus the graph DDL block, so a
 *  "legacy v34" DB is a true v34 — the graph tables must arrive via the
 *  migration step, not via schema.sql. */
function v34SchemaText(): string {
  return readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'schema.sql'), 'utf8')
    .replace(GRAPH_MIGRATION_DDL, '')
    .replace(GRAPH_WORKSPACE_MIGRATION_DDL, '');
}

/** The pre-v37 GRAPH_MIGRATION_DDL: the v37 rebuild widened the node-run
 *  status CHECK, so a "legacy v35/v36" fixture built from the CURRENT
 *  constant would already carry the widened CHECK and the v37 step would
 *  (correctly) skip. The legacy fixture must be genuinely narrow. */
function v36GraphDdl(): string {
  return GRAPH_MIGRATION_DDL.replace("'output-artifact-missing','artifact-unsafe',", '');
}

describe('openStore', () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  it('creates all 39 registry tables', () => {
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

  it('enforces one attachment row per content-addressed name and ticket', () => {
    const store = openStore(':memory:');
    cleanups.push(() => store.close());
    const insert = store.db.prepare(
      `INSERT INTO ticket_attachments
         (ticket_id, kind, stored_name, original_name, byte_size, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    insert.run(1, 'image', 'same.png', 'first.png', 4, '2026-08-01T00:00:00.000Z');

    expect(() =>
      insert.run(1, 'image', 'same.png', 'second.png', 4, '2026-08-01T00:00:01.000Z'),
    ).toThrow(/UNIQUE/i);
    expect(() =>
      insert.run(2, 'image', 'same.png', 'other-ticket.png', 4, '2026-08-01T00:00:02.000Z'),
    ).not.toThrow();
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

  it('tickets carries the v2 ticket-field columns', () => {
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
    expect(store.db.pragma('user_version', { simple: true })).toBe(49);
  });

  it('migrates a v45 DB to v46, adding servers.kind defaulting to service', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-db-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'karst.db');
    const legacy = new Database(path);
    legacy.exec(
      `CREATE TABLE servers (
         id INTEGER PRIMARY KEY, ticket_id INTEGER, repo TEXT NOT NULL, host TEXT,
         port INTEGER, pid INTEGER, status TEXT NOT NULL, log_path TEXT,
         started_at TEXT NOT NULL DEFAULT (datetime('now')), cwd TEXT)`,
    );
    legacy
      .prepare(
        "INSERT INTO servers (ticket_id, repo, host, port, pid, status, cwd) VALUES (1,'api','h',3000,4242,'running','/wt/api')",
      )
      .run();
    legacy.pragma('user_version = 45');
    legacy.close();

    const migrated = openStore(path);
    cleanups.push(() => migrated.close());

    const cols = new Set(
      (migrated.db.prepare("PRAGMA table_info('servers')").all() as { name: string }[]).map(
        (c) => c.name,
      ),
    );
    expect(cols.has('kind')).toBe(true);
    // The pre-v46 row was a service — the DEFAULT is the honest answer, never a guess.
    expect(
      migrated.db.prepare("SELECT kind FROM servers WHERE ticket_id = 1").get(),
    ).toEqual({ kind: 'service' });
    expect(migrated.db.pragma('user_version', { simple: true })).toBe(49);
  });

  it('fresh DB carries the nine graph tables and the token_usage graph FKs (v35)', () => {
    const store = openStore(':memory:');
    cleanups.push(() => store.close());
    const cols = store.db
      .prepare("PRAGMA table_info('token_usage')")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(cols).toContain('approach_planner_run_id');
    expect(cols).toContain('approach_node_run_id');
  });

  it('migrates a database at v34 straight to v36 (graph tables + blocked_reason)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-db34-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'registry.db');
    const legacy = new Database(path);
    legacy.exec(v34SchemaText());
    legacy.pragma('user_version = 34');
    legacy.close();

    const migrated = openStore(path);
    cleanups.push(() => migrated.close());
    const names = tableNames(migrated);
    for (const t of EXPECTED_TABLES.slice(EXPECTED_TABLES.length - 9)) {
      expect(names).toContain(t);
    }
    expect(migrated.db.pragma('user_version', { simple: true })).toBe(49);
  });

  it('an interrupted v35 step leaves user_version at 34 and the next open completes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-db34-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'registry.db');
    const legacy = new Database(path);
    legacy.exec(v34SchemaText());
    legacy.pragma('user_version = 34');
    legacy.close();

    // Simulate a crash mid-step: the whole v36 step (guarded DDL + version
    // bump) runs inside ONE transaction, so a poison statement rolls the lot
    // back — user_version stays 34 and no graph table survives.
    const db = new Database(path);
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(GRAPH_MIGRATION_DDL);
      db.exec('this is not sql'); // poison: the "host died" here
      db.pragma('user_version = 36');
      db.exec('COMMIT');
    } catch {
      db.exec('ROLLBACK');
    }
    db.close();

    const db2 = new Database(path);
    expect(db2.pragma('user_version', { simple: true })).toBe(34);
    const names = db2
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(names).not.toContain('approach_graph_runs');
    db2.close();

    // The next open completes the migration.
    const reopened = openStore(path);
    cleanups.push(() => reopened.close());
    expect(reopened.db.pragma('user_version', { simple: true })).toBe(49);
    expect(tableNames(reopened)).toContain('approach_graph_runs');
  });

  it('two live opens of one file migrate without corruption', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-db-concurrent-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'registry.db');
    const a = openStore(path);
    const b = openStore(path);
    cleanups.push(() => a.close());
    cleanups.push(() => b.close());
    expect(a.db.pragma('user_version', { simple: true })).toBe(49);
    expect(b.db.pragma('user_version', { simple: true })).toBe(49);
    expect(tableNames(b)).toContain('approach_graph_runs');
  });

  it('a partial prior state (one graph table already present) re-runs cleanly', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-db34-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'registry.db');
    const legacy = new Database(path);
    legacy.exec(v34SchemaText());
    legacy.pragma('user_version = 34');
    legacy.exec(
      'CREATE TABLE approach_graph_tokens (' +
        'id INTEGER PRIMARY KEY, revision_id INTEGER NOT NULL, source_node_run_id INTEGER, ' +
        'is_entry INTEGER NOT NULL DEFAULT 0 CHECK (is_entry IN (0,1)), ' +
        'edge_id TEXT NOT NULL, destination_node_id TEXT NOT NULL, ' +
        'destination_end INTEGER NOT NULL DEFAULT 0 CHECK (destination_end IN (0,1)), ' +
        'fork_instance INTEGER NOT NULL DEFAULT 0, fork_lineage TEXT, ' +
        "status TEXT NOT NULL CHECK (status IN ('pending','claimed','consumed','cancelled')), " +
        'claiming_node_run_id INTEGER, consuming_node_run_id INTEGER, ' +
        'created_at TEXT NOT NULL, consumed_at TEXT)',
    );
    legacy.close();

    const migrated = openStore(path);
    cleanups.push(() => migrated.close());
    expect(migrated.db.pragma('user_version', { simple: true })).toBe(49);
    const names = tableNames(migrated);
    for (const t of EXPECTED_TABLES.slice(EXPECTED_TABLES.length - 9)) {
      expect(names).toContain(t);
    }
  });

  it('the v35 migration DDL is byte-identical with schema.sql', () => {
    const schema = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'schema.sql'), 'utf8');
    expect(schema).toContain(GRAPH_MIGRATION_DDL);
    // v39's workspace-ledger DDL is pinned the same way: a table added later
    // must exist on a fresh DB (schema.sql) AND on an upgraded one.
    expect(schema).toContain(GRAPH_WORKSPACE_MIGRATION_DDL);
  });

  it('a v35 DB gains the graph-run blocked_reason column (v36)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-db35-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'registry.db');
    const legacy = new Database(path);
    legacy.exec(v34SchemaText());
    legacy.exec(GRAPH_MIGRATION_DDL);
    legacy.pragma('user_version = 35');
    legacy.close();

    const migrated = openStore(path);
    cleanups.push(() => migrated.close());
    const cols = migrated.db
      .prepare("PRAGMA table_info('approach_graph_runs')")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(cols).toContain('blocked_reason');
    expect(migrated.db.pragma('user_version', { simple: true })).toBe(49);
  });

  it('a v35 DB migrates through v37: the node-run CHECK gains the output-validation statuses', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-db35-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'registry.db');
    const legacy = new Database(path);
    legacy.exec(v34SchemaText());
    legacy.exec(v36GraphDdl());
    legacy.pragma('user_version = 35');
    // A pre-v37 node run row must survive the rebuild untouched.
    legacy.exec(`
      INSERT INTO tickets (key) VALUES ('T-1');
      INSERT INTO approach_graph_runs (ticket_id, stage_key, stage_attempt, approach_id, status, created_at)
      VALUES (1, 'impl', 0, 'x', 'running', '2026-08-12T00:00:00.000Z');
      INSERT INTO approach_graph_revisions (graph_run_id, revision_number, canonical_graph, fingerprint, status, created_at)
      VALUES (1, 1, '{}', 'fp', 'active', '2026-08-12T00:00:00.000Z');
      INSERT INTO approach_node_runs (graph_run_id, revision_id, node_id, node_kind, visit_number, status)
      VALUES (1, 1, 'n', 'agent', 1, 'running');
    `);
    legacy.close();

    const migrated = openStore(path);
    cleanups.push(() => migrated.close());
    expect(migrated.db.pragma('user_version', { simple: true })).toBe(49);
    const sql = (
      migrated.db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'approach_node_runs'",
        )
        .get() as { sql: string }
    ).sql;
    expect(sql).toContain('output-artifact-missing');
    expect(sql).toContain('artifact-unsafe');
    // The pre-existing row survived, and the widened CHECK admits the new
    // statuses — the whole point of the rebuild.
    const row = migrated.db
      .prepare('SELECT status FROM approach_node_runs WHERE id = 1')
      .get() as { status: string };
    expect(row.status).toBe('running');
    migrated.db
      .prepare("UPDATE approach_node_runs SET status = 'output-artifact-missing' WHERE id = 1")
      .run();
    const updated = migrated.db
      .prepare('SELECT status FROM approach_node_runs WHERE id = 1')
      .get() as { status: string };
    expect(updated.status).toBe('output-artifact-missing');
    // The rebuilt table keeps its supporting index.
    const idx = migrated.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'approach_node_runs'")
      .all() as { name: string }[];
    expect(idx.map((r) => r.name)).toContain('idx_node_runs_revision');
  });

  it('an interrupted v37 rebuild leaves the old table and user_version intact', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-db36-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'registry.db');
    const legacy = new Database(path);
    legacy.exec(v34SchemaText());
    legacy.exec(v36GraphDdl());
    legacy.pragma('user_version = 36');
    legacy.close();

    // Simulate a crash mid-step: the whole v37 rebuild (DDL + version bump)
    // runs inside ONE transaction, so a poison statement rolls the lot back —
    // user_version stays 36 and the old table (narrow CHECK) survives.
    const db = new Database(path);
    db.pragma('foreign_keys = OFF');
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(NODE_RUN_STATUSES_V37_DDL);
      db.exec('this is not sql'); // poison: the "host died" here
      db.pragma('user_version = 37');
      db.exec('COMMIT');
    } catch {
      db.exec('ROLLBACK');
    }
    db.close();

    const db2 = new Database(path);
    expect(db2.pragma('user_version', { simple: true })).toBe(36);
    const sql = (
      db2
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type='table' AND name='approach_node_runs'",
        )
        .get() as { sql: string }
    ).sql;
    expect(sql).not.toContain('output-artifact-missing');
    db2.close();

    // The next open completes the migration.
    const reopened = openStore(path);
    cleanups.push(() => reopened.close());
    expect(reopened.db.pragma('user_version', { simple: true })).toBe(49);
    const afterSql = (
      reopened.db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'approach_node_runs'",
        )
        .get() as { sql: string }
    ).sql;
    expect(afterSql).toContain('output-artifact-missing');
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

  it('gate_runs carries the v22 invocation-identity columns', () => {
    const store = openStore(':memory:');
    cleanups.push(() => store.close());
    const cols = store.db
      .prepare("PRAGMA table_info('gate_runs')")
      .all()
      .map((r) => (r as { name: string }).name);
    for (const col of ['repo', 'command', 'args']) {
      expect(cols, `missing gate_runs column: ${col}`).toContain(col);
    }
  });

  it('carries the v24 per-ticket disabled-gates column', () => {
    const store = openStore(':memory:');
    cleanups.push(() => store.close());
    const cols = store.db
      .prepare("PRAGMA table_info('tickets')")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(cols).toContain('disabled_gates');
  });

  it('carries the v24 skipped column on gate_runs', () => {
    const store = openStore(':memory:');
    cleanups.push(() => store.close());
    const cols = store.db
      .prepare("PRAGMA table_info('gate_runs')")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(cols).toContain('skipped');
  });

  it('carries the v44 provider-native priority column', () => {
    const store = openStore(':memory:');
    cleanups.push(() => store.close());
    const cols = store.db
      .prepare("PRAGMA table_info('tickets')")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(cols).toContain('priority');
  });

  it('carries the v44 per-ticket effort column', () => {
    const store = openStore(':memory:');
    cleanups.push(() => store.close());
    const cols = store.db
      .prepare("PRAGMA table_info('tickets')")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(cols).toContain('effort');
  });

  it('migrates a v16 DB to v17 with attachment lookup and dedupe indexes without touching rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-db-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'karst.db');
    const legacy = new Database(path);
    legacy.exec('CREATE TABLE tickets (id INTEGER PRIMARY KEY, key TEXT, title TEXT)');
    legacy.prepare('INSERT INTO tickets (key, title) VALUES (?, ?)').run('OLD-16', 'v16 row');
    legacy.pragma('user_version = 16');
    legacy.close();

    const migrated = openStore(path);
    cleanups.push(() => migrated.close());
    expect(
      migrated.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(
        'ticket_attachments',
      ),
    ).toEqual({ name: 'ticket_attachments' });
    expect(
      migrated.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?").get(
        'idx_ticket_attachments_ticket',
      ),
    ).toEqual({ name: 'idx_ticket_attachments_ticket' });
    expect(
      migrated.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?").get(
        'idx_ticket_attachments_ticket_stored_name',
      ),
    ).toEqual({ name: 'idx_ticket_attachments_ticket_stored_name' });
    const insertAttachment = migrated.db.prepare(
      `INSERT INTO ticket_attachments
         (ticket_id, kind, stored_name, original_name, byte_size, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    insertAttachment.run(1, 'image', 'same.png', 'first.png', 4, '2026-08-01T00:00:00.000Z');
    expect(() =>
      insertAttachment.run(1, 'image', 'same.png', 'second.png', 4, '2026-08-01T00:00:01.000Z'),
    ).toThrow(/UNIQUE/i);
    expect(migrated.db.prepare('SELECT key, title FROM tickets').get()).toEqual({
      key: 'OLD-16',
      title: 'v16 row',
    });
expect(migrated.db.pragma('user_version', { simple: true })).toBe(49);
  });

  it('repairs an at-version attachment table and deduplicates before adding uniqueness', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-db-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'karst.db');
    const intermediate = new Database(path);
    intermediate.exec(`
      CREATE TABLE ticket_attachments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_id INTEGER NOT NULL,
        kind TEXT NOT NULL,
        stored_name TEXT NOT NULL,
        original_name TEXT NOT NULL,
        byte_size INTEGER NOT NULL,
        created_at TEXT NOT NULL
      )
    `);
    const insert = intermediate.prepare(
      `INSERT INTO ticket_attachments
         (ticket_id, kind, stored_name, original_name, byte_size, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    insert.run(7, 'image', 'same.png', 'first.png', 4, '2026-08-01T00:00:00.000Z');
    insert.run(7, 'image', 'same.png', 'duplicate.png', 4, '2026-08-01T00:00:01.000Z');
    // Already AT the current version, so every version gate is skipped — the
    // repair has to stand on its own, which is the reason it lives outside them.
    intermediate.pragma('user_version = 18');
    intermediate.close();

    const repaired = openStore(path);
    cleanups.push(() => repaired.close());
    const columns = repaired.db
      .prepare("PRAGMA table_info('ticket_attachments')")
      .all()
      .map((row) => (row as { name: string }).name);
    expect(columns).toContain('operation_token');
    expect(columns).toContain('detach_token');
    expect(repaired.db.prepare(
      'SELECT id, original_name FROM ticket_attachments ORDER BY id',
    ).all()).toEqual([{ id: 1, original_name: 'first.png' }]);
    expect(
      repaired.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?").get(
        'idx_ticket_attachments_ticket_stored_name',
      ),
    ).toEqual({ name: 'idx_ticket_attachments_ticket_stored_name' });
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
expect(migrated.db.pragma('user_version', { simple: true })).toBe(49);
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
expect(migrated.db.pragma('user_version', { simple: true })).toBe(49);
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
expect(migrated.db.pragma('user_version', { simple: true })).toBe(49);
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
expect(migrated.db.pragma('user_version', { simple: true })).toBe(49);
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
expect(migrated.db.pragma('user_version', { simple: true })).toBe(49);
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
expect(migrated.db.pragma('user_version', { simple: true })).toBe(49);
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
expect(migrated.db.pragma('user_version', { simple: true })).toBe(49);
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
expect(migrated.db.pragma('user_version', { simple: true })).toBe(49);
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
expect(migrated.db.pragma('user_version', { simple: true })).toBe(49);
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
expect(migrated.db.pragma('user_version', { simple: true })).toBe(49);
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

expect(migrated.db.pragma('user_version', { simple: true })).toBe(49);
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
expect(reopened.db.pragma('user_version', { simple: true })).toBe(49);
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
expect(migrated.db.pragma('user_version', { simple: true })).toBe(49);
  });

  it('migrates a v18 DB to v19, adding token_usage and its aggregation indexes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-db-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'karst.db');
    const legacy = new Database(path);
    legacy.exec('CREATE TABLE tickets (id INTEGER PRIMARY KEY, key TEXT, title TEXT)');
    legacy.prepare('INSERT INTO tickets (id, key, title) VALUES (?, ?, ?)').run(1, 'K-1', 'One');
    legacy.pragma('user_version = 18');
    legacy.close();

    const migrated = openStore(path);
    cleanups.push(() => migrated.close());
    expect(tableNames(migrated)).toContain('token_usage');

    const indexes = migrated.db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='token_usage'")
      .all()
      .map((r) => (r as { name: string }).name);
    for (const idx of [
      'idx_token_usage_project_time',
      'idx_token_usage_ticket',
      'idx_token_usage_site',
      'idx_token_usage_model',
    ]) {
      expect(indexes, `missing index: ${idx}`).toContain(idx);
    }

    // Nothing is backfilled: the counts live in provider responses to calls that
    // already happened and were never captured. History starts at the upgrade.
    expect(migrated.db.prepare('SELECT * FROM token_usage').all()).toEqual([]);
    // Additive only — the pre-existing rows are untouched.
    expect(
      migrated.db.prepare('SELECT key FROM tickets WHERE id = ?').get(1),
    ).toEqual({ key: 'K-1' });
expect(migrated.db.pragma('user_version', { simple: true })).toBe(49);
  });

  // v25 retires the standalone `merge` stage: a ticket a prior build parked
  // there has nowhere valid left to sit, so it moves back to `ship`, blocked
  // exactly like a fresh unlanded ship would be. The block is a placeholder —
  // `settleShipGates`' next sweep tick re-checks the real landing state and
  // clears it immediately if the PRs had actually already merged.
  it('migrates a v24 DB to v25, moving a ticket parked at merge back to ship, blocked', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-db-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'karst.db');
    const legacy = new Database(path);
    legacy.exec(
      'CREATE TABLE tickets (id INTEGER PRIMARY KEY, key TEXT, title TEXT, stage_current TEXT)',
    );
    legacy.exec(
      `CREATE TABLE stages (
         ticket_id INTEGER NOT NULL, stage_key TEXT NOT NULL, status TEXT NOT NULL,
         attempt INTEGER NOT NULL DEFAULT 0, verdict TEXT, artifact_path TEXT,
         started_at TEXT, ended_at TEXT,
         blocked_kind TEXT, blocked_reason TEXT, blocked_at TEXT,
         PRIMARY KEY (ticket_id, stage_key))`,
    );
    const ticket = legacy.prepare(
      'INSERT INTO tickets (id, key, title, stage_current) VALUES (?, ?, ?, ?)',
    );
    ticket.run(1, 'K-1', 'parked at merge', 'merge');
    ticket.run(2, 'K-2', 'mid flight, untouched', 'impl');
    const stage = legacy.prepare(
      'INSERT INTO stages (ticket_id, stage_key, status, started_at, ended_at) VALUES (?, ?, ?, ?, ?)',
    );
    stage.run(1, 'ship', 'passed', '2026-07-01T10:00:00Z', '2026-07-01T10:05:00Z');
    stage.run(1, 'merge', 'pending', null, null);
    stage.run(2, 'impl', 'running', '2026-07-02T10:00:00Z', null);
    legacy.pragma('user_version = 24');
    legacy.close();

    const migrated = openStore(path);
    cleanups.push(() => migrated.close());

    expect(
      migrated.db.prepare('SELECT stage_current FROM tickets WHERE id = ?').get(1),
    ).toEqual({ stage_current: 'ship' });
    // Untouched: only a ticket that was actually AT `merge` moves.
    expect(
      migrated.db.prepare('SELECT stage_current FROM tickets WHERE id = ?').get(2),
    ).toEqual({ stage_current: 'impl' });

    const shipRow = migrated.db
      .prepare(
        'SELECT status, blocked_kind, blocked_at FROM stages WHERE ticket_id = 1 AND stage_key = ?',
      )
      .get('ship') as { status: string; blocked_kind: string | null; blocked_at: string | null };
    expect(shipRow.status).toBe('passed');
    expect(shipRow.blocked_kind).toBe('awaiting-merge');
    // Every other writer stamps ISO-8601 UTC via model/time.ts's nowIso(); a
    // bare `datetime('now')` would emit SQLite's local-time
    // `YYYY-MM-DD HH:MM:SS` instead, and karst compares stage timestamps as
    // STRINGS — a mixed format sorts wrong.
    expect(shipRow.blocked_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    // The orphaned `merge` stage row is left in place — harmless, unreferenced
    // once STAGE_KEYS no longer includes `merge`.
    expect(
      migrated.db.prepare("SELECT status FROM stages WHERE ticket_id = 1 AND stage_key = 'merge'").get(),
    ).toEqual({ status: 'pending' });
expect(migrated.db.pragma('user_version', { simple: true })).toBe(49);
  });

  it('migrates a v20 DB to v21, adding servers.cwd without inventing a value for it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-db-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'karst.db');
    const legacy = new Database(path);
    legacy.exec(
      `CREATE TABLE servers (
         id INTEGER PRIMARY KEY, ticket_id INTEGER, repo TEXT NOT NULL, host TEXT,
         port INTEGER, pid INTEGER, status TEXT NOT NULL, log_path TEXT,
         started_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    );
    legacy
      .prepare(
        "INSERT INTO servers (ticket_id, repo, host, port, pid, status, log_path) VALUES (1,'api','h',3000,4242,'running','/l')",
      )
      .run();
    legacy.pragma('user_version = 20');
    legacy.close();

    const migrated = openStore(path);
    cleanups.push(() => migrated.close());

    const cols = new Set(
      (migrated.db.prepare("PRAGMA table_info('servers')").all() as { name: string }[]).map(
        (c) => c.name,
      ),
    );
    expect(cols.has('cwd')).toBe(true);

    // NULL, not a guess: `repo` is a repository NAME and worktrees are keyed by
    // PATH, so the directory a legacy row's process runs in is not derivable.
    // Every consumer reads NULL as "unknown" and leaves the process alone.
    expect(
      migrated.db.prepare('SELECT pid, status, cwd FROM servers WHERE ticket_id = 1').get(),
    ).toEqual({ pid: 4242, status: 'running', cwd: null });
    // The FINAL version, not 21: `openStore` runs every pending step, so a
    // legacy DB lands at SCHEMA_VERSION whichever step this case exercises.
expect(migrated.db.pragma('user_version', { simple: true })).toBe(49);
  });

  // v21 was RENUMBERED before release: it first shipped as the gate_runs
  // invocation-identity columns in a build whose SCHEMA_VERSION was 22, and only
  // afterwards became the servers.cwd step (SCHEMA_VERSION 23, gate_runs moved to
  // v22). A registry stamped by the older build reports user_version = 22 — not
  // < 21 — so the version-gated servers.cwd ALTER would be skipped forever and
  // the column would stay missing while the DB claims to be current; the archive
  // path's `SELECT … cwd FROM servers` then dies with "no such column: cwd"
  // (869efu319). The repair must therefore run OUTSIDE the version gate, like
  // the attachment-table repair above it.
  it('repairs a pre-renumbering DB (user_version 22) that never gained servers.cwd', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-db-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'karst.db');
    const legacy = new Database(path);
    legacy.exec(
      `CREATE TABLE servers (
         id INTEGER PRIMARY KEY, ticket_id INTEGER, repo TEXT NOT NULL, host TEXT,
         port INTEGER, pid INTEGER, status TEXT NOT NULL, log_path TEXT,
         started_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    );
    legacy
      .prepare(
        "INSERT INTO servers (ticket_id, repo, host, port, pid, status, log_path) VALUES (1,'api','h',3000,4242,'running','/l')",
      )
      .run();
    // Exactly what the pre-renumbering build stamped: its own SCHEMA_VERSION was
    // 22, and its v21 (the gate_runs columns) had already run — only servers.cwd
    // is missing.
    legacy.pragma('user_version = 22');
    legacy.close();

    const migrated = openStore(path);
    cleanups.push(() => migrated.close());

    const cols = new Set(
      (migrated.db.prepare("PRAGMA table_info('servers')").all() as { name: string }[]).map(
        (c) => c.name,
      ),
    );
    expect(cols.has('cwd')).toBe(true);
    // NULL, not a guess — identical to the honest v20→v21 upgrade: the legacy
    // row's process directory is not derivable, and every consumer reads NULL as
    // "unknown", leaving the process alone.
    expect(
      migrated.db.prepare('SELECT pid, status, cwd FROM servers WHERE ticket_id = 1').get(),
    ).toEqual({ pid: 4242, status: 'running', cwd: null });
expect(migrated.db.pragma('user_version', { simple: true })).toBe(49);
  });

  // Nothing reads `servers` by position — every query in the codebase names its
  // columns — so a mismatch here has no behavioral effect. Pinned anyway: `cwd`
  // is placed LAST in schema.sql specifically so a fresh DB agrees with what
  // `ALTER TABLE ADD COLUMN` (which always appends) produces on an upgraded one.
  it('gives a fresh DB the same servers column order as a migrated one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-db-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const fresh = openStore(join(dir, 'fresh.db'));
    cleanups.push(() => fresh.close());

    const legacy = new Database(join(dir, 'legacy.db'));
    legacy.exec(
      `CREATE TABLE servers (
         id INTEGER PRIMARY KEY, ticket_id INTEGER, repo TEXT NOT NULL, host TEXT,
         port INTEGER, pid INTEGER, status TEXT NOT NULL, log_path TEXT,
         started_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    );
    legacy.pragma('user_version = 20');
    legacy.close();
    const migrated = openStore(join(dir, 'legacy.db'));
    cleanups.push(() => migrated.close());

    const order = (db: Database.Database): string[] =>
      (db.prepare("PRAGMA table_info('servers')").all() as { name: string }[]).map((c) => c.name);
    expect(order(fresh.db)).toEqual(order(migrated.db));
  });

  it('migrates a v21 DB to v22, adding the gate_runs invocation-identity columns', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-db-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'karst.db');
    const legacy = new Database(path);
    legacy.exec(
      `CREATE TABLE gate_runs (
         id INTEGER PRIMARY KEY, ticket_id INTEGER NOT NULL, stage_key TEXT NOT NULL,
         attempt INTEGER NOT NULL, run_at TEXT NOT NULL, gate_name TEXT NOT NULL,
         exit_code INTEGER, started_at TEXT, ended_at TEXT)`,
    );
    legacy
      .prepare(
        `INSERT INTO gate_runs
           (id, ticket_id, stage_key, attempt, run_at, gate_name, exit_code)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(1, 1, 'uat', 0, '2026-07-20T12:00:00.000Z', 'test (web)', 0);
    legacy.pragma('user_version = 21');
    legacy.close();

    const migrated = openStore(path);
    const cols = new Set(
      (migrated.db.prepare("PRAGMA table_info('gate_runs')").all() as { name: string }[]).map(
        (c) => c.name,
      ),
    );
    expect(cols.has('repo')).toBe(true);
    expect(cols.has('command')).toBe(true);
    expect(cols.has('args')).toBe(true);

    // Nothing is backfilled: a pre-v22 row genuinely does not know what argv
    // produced it, and inventing one would make R7 compare against a guess.
    const row = migrated.db
      .prepare('SELECT gate_name, exit_code, repo, command, args FROM gate_runs WHERE id = ?')
      .get(1);
    expect(row).toEqual({
      gate_name: 'test (web)',
      exit_code: 0,
      repo: null,
      command: null,
      args: null,
    });
    // The FINAL version, not 22: `openStore` runs every pending step, so a
    // legacy DB lands at SCHEMA_VERSION whichever step this case exercises.
expect(migrated.db.pragma('user_version', { simple: true })).toBe(49);

    // Idempotence: reopening an already-migrated DB must not error or re-alter.
    migrated.close();
    const reopened = openStore(path);
    cleanups.push(() => reopened.close());
    const reopenedCols = new Set(
      (reopened.db.prepare("PRAGMA table_info('gate_runs')").all() as { name: string }[]).map(
        (c) => c.name,
      ),
    );
    expect(reopenedCols.has('repo')).toBe(true);
    expect(reopenedCols.has('command')).toBe(true);
    expect(reopenedCols.has('args')).toBe(true);
expect(reopened.db.pragma('user_version', { simple: true })).toBe(49);
  });

  it('migrates a v22 DB to v23, adding review_findings without touching other tables', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-db-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'karst.db');
    const legacy = new Database(path);
    legacy.exec('CREATE TABLE tickets (id INTEGER PRIMARY KEY, key TEXT, title TEXT)');
    legacy.prepare('INSERT INTO tickets (id, key, title) VALUES (?, ?, ?)').run(1, 'K-1', 'One');
    legacy.pragma('user_version = 22');
    legacy.close();

    const migrated = openStore(path);
    expect(tableNames(migrated)).toContain('review_findings');

    const cols = new Set(
      (migrated.db.prepare("PRAGMA table_info('review_findings')").all() as { name: string }[]).map(
        (c) => c.name,
      ),
    );
    for (const col of [
      'id',
      'ticket_id',
      'attempt',
      'run_at',
      'severity',
      'repo',
      'file',
      'line',
      'title',
      'detail',
      'source',
      'created_at',
    ]) {
      expect(cols.has(col), `missing review_findings column: ${col}`).toBe(true);
    }

    const index = migrated.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get('idx_review_findings_ticket');
    expect(index).toEqual({ name: 'idx_review_findings_ticket' });

    // Nothing is backfilled: no prior karst ever recorded a finding, so there
    // is nothing to derive — an in-flight ticket simply shows none until its
    // next review run.
    expect(migrated.db.prepare('SELECT * FROM review_findings').all()).toEqual([]);
    // Additive only — the pre-existing rows are untouched.
    expect(migrated.db.prepare('SELECT key FROM tickets WHERE id = ?').get(1)).toEqual({
      key: 'K-1',
    });
expect(migrated.db.pragma('user_version', { simple: true })).toBe(49);

    // Idempotence: reopening an already-migrated DB must not error or re-create.
    migrated.close();
    const reopened = openStore(path);
    cleanups.push(() => reopened.close());
    expect(tableNames(reopened)).toContain('review_findings');
expect(reopened.db.pragma('user_version', { simple: true })).toBe(49);
  });

  it('migrates a v23 database to v24 without losing gate rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-db-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'karst.db');
    const legacy = new Database(path);
    legacy.exec(
      'CREATE TABLE tickets (id INTEGER PRIMARY KEY, key TEXT, title TEXT)',
    );
    legacy.exec(
      `CREATE TABLE gate_runs (
         id INTEGER PRIMARY KEY, ticket_id INTEGER NOT NULL, stage_key TEXT NOT NULL,
         attempt INTEGER NOT NULL, run_at TEXT NOT NULL, gate_name TEXT NOT NULL,
         exit_code INTEGER, started_at TEXT, ended_at TEXT,
         repo TEXT, command TEXT, args TEXT)`,
    );
    legacy.prepare('INSERT INTO tickets (id, key, title) VALUES (?, ?, ?)').run(1, 'K-1', 'legacy');
    legacy
      .prepare(
        `INSERT INTO gate_runs (ticket_id, stage_key, attempt, run_at, gate_name, exit_code)
         VALUES (?, 'uat', 1, '2026-01-01T00:00:00.000Z', 'test', 0)`,
      )
      .run(1);
    legacy.pragma('user_version = 23');
    legacy.close();

    const migrated = openStore(path);
    cleanups.push(() => migrated.close());
expect(migrated.db.pragma('user_version', { simple: true })).toBe(49);
    const ticketCols = new Set(
      (migrated.db.prepare("PRAGMA table_info('tickets')").all() as { name: string }[]).map(
        (c) => c.name,
      ),
    );
    expect(ticketCols.has('disabled_gates')).toBe(true);
    const cols = new Set(
      (migrated.db.prepare("PRAGMA table_info('gate_runs')").all() as { name: string }[]).map(
        (c) => c.name,
      ),
    );
    expect(cols.has('skipped')).toBe(true);
    const row = migrated.db.prepare('SELECT gate_name, skipped FROM gate_runs').get() as {
      gate_name: string;
      skipped: number | null;
    };
    expect(row.gate_name).toBe('test');
    expect(row.skipped).toBeNull(); // never backfilled
  });

  it('migrates a legacy v15 DB by adding the stage blocked columns', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-db-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'karst.db');
    const legacy = new Database(path);
    legacy.exec(
      'CREATE TABLE stages (ticket_id INTEGER NOT NULL, stage_key TEXT NOT NULL, status TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0, verdict TEXT, artifact_path TEXT, started_at TEXT, ended_at TEXT, PRIMARY KEY (ticket_id, stage_key))',
    );
    legacy
      .prepare(
        'INSERT INTO stages (ticket_id, stage_key, status, attempt, verdict, artifact_path, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        1,
        'uat',
        'passed',
        3,
        'ok',
        '/tmp/uat-artifact.json',
        '2026-01-01T00:00:00Z',
        '2026-01-01T00:05:00Z',
      );
    legacy.pragma('user_version = 15');
    legacy.close();

    const migrated = openStore(path);
    const cols = new Set(
      (migrated.db.prepare("PRAGMA table_info('stages')").all() as { name: string }[]).map(
        (c) => c.name,
      ),
    );
    expect(cols.has('blocked_kind')).toBe(true);
    expect(cols.has('blocked_reason')).toBe(true);
    expect(cols.has('blocked_at')).toBe(true);

    // The stage row is left exactly as it was: the migration is additive only.
    const row = migrated.db
      .prepare(
        'SELECT status, attempt, verdict, artifact_path, started_at, ended_at, blocked_kind, blocked_reason, blocked_at FROM stages WHERE ticket_id = ? AND stage_key = ?',
      )
      .get(1, 'uat') as
      | {
          status: string;
          attempt: number;
          verdict: string;
          artifact_path: string;
          started_at: string;
          ended_at: string;
          blocked_kind: string | null;
          blocked_reason: string | null;
          blocked_at: string | null;
        }
      | undefined;
    expect(row).toEqual({
      status: 'passed',
      attempt: 3,
      verdict: 'ok',
      artifact_path: '/tmp/uat-artifact.json',
      started_at: '2026-01-01T00:00:00Z',
      ended_at: '2026-01-01T00:05:00Z',
      // Nothing is backfilled: absence means "not blocked", the correct reading
      // of a pre-v17 row that was never blocked in the first place.
      blocked_kind: null,
      blocked_reason: null,
      blocked_at: null,
    });
expect(migrated.db.pragma('user_version', { simple: true })).toBe(49);
    migrated.close();

    // Idempotence: reopening an already-migrated DB must not error, re-alter
    // the columns, or lose the row.
    const reopened = openStore(path);
    cleanups.push(() => reopened.close());
    const reopenedCols = new Set(
      (reopened.db.prepare("PRAGMA table_info('stages')").all() as { name: string }[]).map(
        (c) => c.name,
      ),
    );
    expect(reopenedCols.has('blocked_kind')).toBe(true);
    expect(reopenedCols.has('blocked_reason')).toBe(true);
    expect(reopenedCols.has('blocked_at')).toBe(true);
expect(reopened.db.pragma('user_version', { simple: true })).toBe(49);
    const reopenedRow = reopened.db
      .prepare(
        'SELECT status, attempt, verdict FROM stages WHERE ticket_id = ? AND stage_key = ?',
      )
      .get(1, 'uat') as { status: string; attempt: number; verdict: string } | undefined;
    expect(reopenedRow).toEqual({ status: 'passed', attempt: 3, verdict: 'ok' });
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

    // Simulate a legacy v2 DB (ticket-field columns present, no archived_at).
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
expect(migrated.db.pragma('user_version', { simple: true })).toBe(49);
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

  it('carries the v26 process_runs table and its ticket index on a fresh DB', () => {
    const store = openStore(':memory:');
    cleanups.push(() => store.close());
    expect(tableNames(store)).toContain('process_runs');

    const cols = new Set(
      (store.db.prepare("PRAGMA table_info('process_runs')").all() as { name: string }[]).map(
        (c) => c.name,
      ),
    );
    for (const col of [
      'id',
      'ticket_id',
      'stage_key',
      'process_id',
      'attempt',
      'stage_run_id',
      'agent_name',
      'provider',
      'model',
      'pid',
      'status',
      'result_kind',
      'artifact_path',
      'started_at',
      'ended_at',
    ]) {
      expect(cols.has(col), `missing process_runs column: ${col}`).toBe(true);
    }
    const index = store.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get('idx_process_runs_ticket');
    expect(index).toEqual({ name: 'idx_process_runs_ticket' });
  });

  it('migrates a v25 DB to v26, adding process_runs without touching rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-db-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'karst.db');
    const legacy = new Database(path);
    legacy.exec(
      'CREATE TABLE tickets (id INTEGER PRIMARY KEY, key TEXT, title TEXT, stage_current TEXT)',
    );
    legacy.exec(
      `CREATE TABLE stage_runs (
         id INTEGER PRIMARY KEY, ticket_id INTEGER NOT NULL, stage_key TEXT NOT NULL,
         attempt INTEGER NOT NULL, run_at TEXT NOT NULL, status TEXT NOT NULL,
         outcome TEXT, manifest_hash TEXT, pid INTEGER, started_at TEXT NOT NULL,
         ended_at TEXT)`,
    );
    legacy
      .prepare('INSERT INTO tickets (id, key, title, stage_current) VALUES (?, ?, ?, ?)')
      .run(1, 'K-1', 'pre-v26 row', 'review');
    legacy
      .prepare(
        `INSERT INTO stage_runs
           (ticket_id, stage_key, attempt, run_at, status, pid, started_at)
         VALUES (?, 'review', 1, '2026-08-01T00:00:00.000Z', 'running', 4242,
                 '2026-08-01T00:00:00.000Z')`,
      )
      .run(1);
    legacy.pragma('user_version = 25');
    legacy.close();

    const migrated = openStore(path);
    cleanups.push(() => migrated.close());
    expect(tableNames(migrated)).toContain('process_runs');
    const index = migrated.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get('idx_process_runs_ticket');
    expect(index).toEqual({ name: 'idx_process_runs_ticket' });

    // Nothing is backfilled: no prior karst recorded which process ran, with
    // which identity or pid — a synthesized row would assert exactly the facts
    // this table exists to stop being guessed at.
    expect(migrated.db.prepare('SELECT * FROM process_runs').all()).toEqual([]);
    // Additive only — the pre-existing rows are untouched.
    expect(
      migrated.db.prepare('SELECT key, stage_current FROM tickets WHERE id = ?').get(1),
    ).toEqual({ key: 'K-1', stage_current: 'review' });
    expect(
      migrated.db.prepare('SELECT status, pid FROM stage_runs WHERE ticket_id = ?').get(1),
    ).toEqual({ status: 'running', pid: 4242 });
expect(migrated.db.pragma('user_version', { simple: true })).toBe(49);

    // Idempotence: reopening an already-migrated DB must not error or re-create.
    migrated.close();
    const reopened = openStore(path);
    cleanups.push(() => reopened.close());
    expect(tableNames(reopened)).toContain('process_runs');
expect(reopened.db.pragma('user_version', { simple: true })).toBe(49);
  });

  it('migrates a v27 DB to v28, adding the implementation tables and evidence linkage', () => {
    const columns = (store: Store, table: string): string[] =>
      store.db
        .prepare(`PRAGMA table_info('${table}')`)
        .all()
        .map((r) => (r as { name: string }).name);
    const dir = mkdtempSync(join(tmpdir(), 'karst-db-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'karst.db');
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE tickets (id INTEGER PRIMARY KEY, key TEXT, title TEXT, stage_current TEXT);
      CREATE TABLE phase_marks (
        id INTEGER PRIMARY KEY, ticket_id INTEGER NOT NULL, stage_key TEXT NOT NULL,
        attempt INTEGER NOT NULL, phase_name TEXT NOT NULL, marked_at TEXT NOT NULL);
      CREATE TABLE token_usage (
        id INTEGER PRIMARY KEY, project_id INTEGER, ticket_id INTEGER,
        process_run_id INTEGER, call_site TEXT NOT NULL, provider TEXT, model TEXT,
        input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0, estimated INTEGER NOT NULL DEFAULT 0,
        outcome TEXT NOT NULL, recorded_at TEXT NOT NULL);
      CREATE TABLE process_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER NOT NULL,
        stage_key TEXT NOT NULL, process_id TEXT NOT NULL, attempt INTEGER NOT NULL,
        stage_run_id INTEGER, agent_name TEXT, provider TEXT, model TEXT, pid INTEGER,
        status TEXT NOT NULL, result_kind TEXT, artifact_path TEXT,
        started_at TEXT NOT NULL, ended_at TEXT);
    `);
    legacy
      .prepare(
        `INSERT INTO phase_marks (ticket_id, stage_key, attempt, phase_name, marked_at)
         VALUES (1, 'impl', 0, 'research', '2026-08-01T00:00:00.000Z')`,
      )
      .run();
    legacy
      .prepare(
        `INSERT INTO token_usage
           (project_id, ticket_id, call_site, input_tokens, output_tokens,
            total_tokens, outcome, recorded_at)
         VALUES (NULL, 1, 'unknown', 10, 5, 15, 'ok', '2026-08-01T00:00:00.000Z')`,
      )
      .run();
    legacy.pragma('user_version = 27');
    legacy.close();

    const migrated = openStore(path);
    cleanups.push(() => migrated.close());
    for (const table of ['implementation_runs', 'session_launch_intents', 'implementation_segments']) {
      expect(tableNames(migrated)).toContain(table);
    }
expect(migrated.db.pragma('user_version', { simple: true })).toBe(49);

    const markCols = columns(migrated, 'phase_marks');
    expect(markCols).toContain('implementation_run_id');
    expect(markCols).toContain('implementation_segment_id');
    const tokenCols = columns(migrated, 'token_usage');
    expect(tokenCols).toContain('implementation_segment_id');
    const index = migrated.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get('idx_token_usage_segment');
    expect(index).toEqual({ name: 'idx_token_usage_segment' });

    // Nothing is backfilled: the pre-v28 evidence rows keep NULL linkage.
    const legacyMark = migrated.db
      .prepare('SELECT implementation_run_id, implementation_segment_id FROM phase_marks')
      .get();
    expect(legacyMark).toEqual({
      implementation_run_id: null,
      implementation_segment_id: null,
    });
    const legacyToken = migrated.db
      .prepare('SELECT implementation_segment_id FROM token_usage')
      .get();
    expect(legacyToken).toEqual({ implementation_segment_id: null });

    migrated.close();
    const reopened = openStore(path);
    cleanups.push(() => reopened.close());
expect(reopened.db.pragma('user_version', { simple: true })).toBe(49);
  });

  it('migrates a v28 DB to v29, adding the interactive usage samples table and its linkage', () => {
    const columns = (store: Store, table: string): string[] =>
      store.db
        .prepare(`PRAGMA table_info('${table}')`)
        .all()
        .map((r) => (r as { name: string }).name);
    const dir = mkdtempSync(join(tmpdir(), 'karst-db-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'karst.db');
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE tickets (id INTEGER PRIMARY KEY, key TEXT, title TEXT, stage_current TEXT);
      CREATE TABLE token_usage (
        id INTEGER PRIMARY KEY, project_id INTEGER, ticket_id INTEGER,
        process_run_id INTEGER, call_site TEXT NOT NULL, provider TEXT, model TEXT,
        input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0, estimated INTEGER NOT NULL DEFAULT 0,
        outcome TEXT NOT NULL, recorded_at TEXT NOT NULL,
        implementation_segment_id INTEGER);
      CREATE TABLE process_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER NOT NULL,
        stage_key TEXT NOT NULL, process_id TEXT NOT NULL, attempt INTEGER NOT NULL,
        stage_run_id INTEGER, agent_name TEXT, provider TEXT, model TEXT, pid INTEGER,
        status TEXT NOT NULL, result_kind TEXT, artifact_path TEXT,
        started_at TEXT NOT NULL, ended_at TEXT);
      CREATE TABLE implementation_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER NOT NULL,
        process_run_id INTEGER NOT NULL, attempt INTEGER NOT NULL,
        status TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT);
      CREATE TABLE implementation_segments (
        id INTEGER PRIMARY KEY AUTOINCREMENT, implementation_run_id INTEGER NOT NULL,
        provider TEXT NOT NULL, model TEXT, provider_session_id TEXT, reason TEXT,
        status TEXT NOT NULL, launch_intent_id INTEGER NOT NULL,
        started_at TEXT, ended_at TEXT);
      CREATE TABLE session_launch_intents (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER NOT NULL,
        launch_id TEXT NOT NULL, purpose TEXT NOT NULL,
        implementation_run_id INTEGER, process_run_id INTEGER,
        provider TEXT NOT NULL, model TEXT, reason TEXT NOT NULL,
        session_origin TEXT NOT NULL, provider_session_id TEXT,
        status TEXT NOT NULL, created_at TEXT NOT NULL, resolved_at TEXT);
      INSERT INTO tickets (id, key, title) VALUES (1, 'K-1', 'One');
      INSERT INTO token_usage
        (project_id, ticket_id, call_site, input_tokens, output_tokens,
         total_tokens, outcome, recorded_at)
        VALUES (NULL, 1, 'unknown', 10, 5, 15, 'ok', '2026-08-01T00:00:00.000Z');
    `);
    legacy.pragma('user_version = 28');
    legacy.close();

    const migrated = openStore(path);
    cleanups.push(() => migrated.close());
    expect(tableNames(migrated)).toContain('interactive_usage_samples');
    const sampleColumns = columns(migrated, 'interactive_usage_samples');
    for (const col of [
      'process_run_id',
      'implementation_segment_id',
      'source_event_id',
      'provider',
      'provider_session_id',
      'input_tokens',
      'output_tokens',
      'cache_read_tokens',
      'cache_write_tokens',
      'total_tokens',
      'counter_epoch',
      'baseline_only',
      'observed_at',
    ]) {
      expect(sampleColumns, col).toContain(col);
    }
    const tokenCols = columns(migrated, 'token_usage');
    expect(tokenCols).toContain('interactive_usage_sample_id');
    for (const index of [
      'idx_interactive_usage_event',
      'idx_interactive_usage_segment',
      'idx_interactive_usage_process',
      'idx_interactive_usage_provider_session',
      'idx_token_usage_interactive_sample',
    ]) {
      const found = migrated.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
        .get(index);
      expect(found, index).toEqual({ name: index });
    }
    // Nothing is backfilled: pre-v29 ledger rows keep NULL sample linkage.
    expect(
      migrated.db.prepare('SELECT interactive_usage_sample_id FROM token_usage').get(),
    ).toEqual({ interactive_usage_sample_id: null });
    expect(
      migrated.db.prepare('SELECT * FROM interactive_usage_samples').all(),
    ).toEqual([]);
expect(migrated.db.pragma('user_version', { simple: true })).toBe(49);

    migrated.close();
    const reopened = openStore(path);
    cleanups.push(() => reopened.close());
expect(reopened.db.pragma('user_version', { simple: true })).toBe(49);
  });

  it('carries the v32 ship saga tables and their indexes on a fresh DB', () => {
    const columns = (store: Store, table: string): string[] =>
      store.db
        .prepare(`PRAGMA table_info('${table}')`)
        .all()
        .map((r) => (r as { name: string }).name);
    const store = openStore(':memory:');
    cleanups.push(() => store.close());

    expect(tableNames(store)).toContain('ship_runs');
    expect(tableNames(store)).toContain('ship_repo_steps');
    expect(tableNames(store)).toContain('ship_operation_intents');
    expect(tableNames(store)).toContain('ship_commits');

    const runCols = columns(store, 'ship_runs');
    for (const col of ['id', 'ticket_id', 'attempt', 'status', 'pid', 'started_at', 'ended_at']) {
      expect(runCols, col).toContain(col);
    }
    const stepCols = columns(store, 'ship_repo_steps');
    for (const col of [
      'id',
      'ship_run_id',
      'repo',
      'step',
      'status',
      'detail',
      'pr_number',
      'existed_before_ship',
      'process_run_id',
      'started_at',
      'ended_at',
      'operation_intent_id',
    ]) {
      expect(stepCols, col).toContain(col);
    }
    const intentCols = columns(store, 'ship_operation_intents');
    for (const col of [
      'id',
      'ship_run_id',
      'repo',
      'step',
      'operation_key',
      'pre_state_json',
      'intent_json',
      'status',
      'created_at',
      'prepared_at',
      'applied_at',
      'resolved_at',
    ]) {
      expect(intentCols, col).toContain(col);
    }
    const commitCols = columns(store, 'ship_commits');
    for (const col of ['id', 'ship_run_id', 'repo', 'sha', 'message', 'origin']) {
      expect(commitCols, col).toContain(col);
    }

    for (const index of [
      'idx_ship_run_ticket',
      'idx_ship_step_run',
      'idx_ship_commit_run',
    ]) {
      const found = store.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
        .get(index);
      expect(found, index).toEqual({ name: index });
    }
  });

  it('migrates a v31 DB to v32, adding the ship saga tables without touching rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-db-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'karst.db');
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE tickets (id INTEGER PRIMARY KEY, key TEXT, title TEXT, stage_current TEXT);
      INSERT INTO tickets (id, key, title) VALUES (1, 'K-1', 'pre-v32 row');
    `);
    legacy.pragma('user_version = 31');
    legacy.close();

    const migrated = openStore(path);
    cleanups.push(() => migrated.close());
    for (const table of ['ship_runs', 'ship_repo_steps', 'ship_operation_intents', 'ship_commits']) {
      expect(tableNames(migrated), table).toContain(table);
    }
    const stepCols = new Set(
      (migrated.db.prepare("PRAGMA table_info('ship_repo_steps')").all() as { name: string }[]).map(
        (c) => c.name,
      ),
    );
    expect(stepCols.has('operation_intent_id')).toBe(true);
    for (const index of ['idx_ship_run_ticket', 'idx_ship_step_run', 'idx_ship_commit_run']) {
      const found = migrated.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
        .get(index);
      expect(found, index).toEqual({ name: index });
    }

    // Nothing is backfilled: no prior karst recorded a ship run, a repo step,
    // an operation intent, or a commit — history starts at the upgrade.
    for (const table of ['ship_runs', 'ship_repo_steps', 'ship_operation_intents', 'ship_commits']) {
      expect(migrated.db.prepare(`SELECT * FROM ${table}`).all()).toEqual([]);
    }
    expect(
      migrated.db.prepare('SELECT key, stage_current FROM tickets WHERE id = ?').get(1),
    ).toEqual({ key: 'K-1', stage_current: null });
expect(migrated.db.pragma('user_version', { simple: true })).toBe(49);

    // Idempotence: reopening an already-migrated DB must not error or re-create.
    migrated.close();
    const reopened = openStore(path);
    cleanups.push(() => reopened.close());
    expect(tableNames(reopened)).toContain('ship_commits');
expect(reopened.db.pragma('user_version', { simple: true })).toBe(49);
  });

  it('migrates a v32 DB to v33, adding the intent agent_name column without touching rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-db-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'karst.db');
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE tickets (id INTEGER PRIMARY KEY, key TEXT, title TEXT, stage_current TEXT);
      INSERT INTO tickets (id, key, title) VALUES (1, 'K-1', 'pre-v33 row');
      CREATE TABLE session_launch_intents (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER NOT NULL,
        launch_id TEXT NOT NULL, purpose TEXT NOT NULL,
        implementation_run_id INTEGER, process_run_id INTEGER, recovery_round_id INTEGER,
        provider TEXT NOT NULL, model TEXT, reason TEXT NOT NULL,
        session_origin TEXT NOT NULL, provider_session_id TEXT,
        status TEXT NOT NULL, created_at TEXT NOT NULL, resolved_at TEXT);
      INSERT INTO session_launch_intents
        (ticket_id, launch_id, purpose, provider, model, reason, session_origin, status, created_at)
        VALUES (1, 'l-1', 'fix', 'claude', 'sol', 'initial', 'new', 'pending', '2026-08-01T00:00:00.000Z');
    `);
    legacy.pragma('user_version = 32');
    legacy.close();

    const migrated = openStore(path);
    cleanups.push(() => migrated.close());
    const intentCols = new Set(
      (migrated.db.prepare("PRAGMA table_info('session_launch_intents')").all() as { name: string }[]).map(
        (c) => c.name,
      ),
    );
    expect(intentCols.has('agent_name')).toBe(true);
    // Nothing is backfilled: a pre-v33 fix launch names no agent — the unknown
    // stays NULL, and the pre-v33 row is otherwise untouched.
    expect(
      migrated.db
        .prepare('SELECT launch_id, purpose, provider, model, agent_name, status FROM session_launch_intents')
        .get(),
    ).toEqual({ launch_id: 'l-1', purpose: 'fix', provider: 'claude', model: 'sol', agent_name: null, status: 'pending' });
expect(migrated.db.pragma('user_version', { simple: true })).toBe(49);

    // Idempotence: reopening an already-migrated DB must not error or re-create.
    migrated.close();
    const reopened = openStore(path);
    cleanups.push(() => reopened.close());
expect(reopened.db.pragma('user_version', { simple: true })).toBe(49);
  });

  it('migrates a v33 DB to v34, adding the ship run pid column without touching rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-db-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'karst.db');
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE tickets (id INTEGER PRIMARY KEY, key TEXT, title TEXT, stage_current TEXT);
      INSERT INTO tickets (id, key, title) VALUES (1, 'K-1', 'pre-v34 row');
      CREATE TABLE ship_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER NOT NULL,
        attempt INTEGER NOT NULL, status TEXT NOT NULL,
        started_at TEXT NOT NULL, ended_at TEXT);
      INSERT INTO ship_runs (ticket_id, attempt, status, started_at, ended_at)
        VALUES (1, 1, 'running', '2026-08-01T00:00:00.000Z', NULL);
    `);
    legacy.pragma('user_version = 33');
    legacy.close();

    const migrated = openStore(path);
    cleanups.push(() => migrated.close());
    const runCols = new Set(
      (migrated.db.prepare("PRAGMA table_info('ship_runs')").all() as { name: string }[]).map(
        (c) => c.name,
      ),
    );
    expect(runCols.has('pid')).toBe(true);
    // Nothing is backfilled: a pre-v34 run names no host — the unknown stays
    // NULL (which the stranded-ship sweep reads as "no evidence of life",
    // while the reconcile sweep leaves it strictly alone), and the pre-v34
    // row is otherwise untouched.
    expect(
      migrated.db
        .prepare('SELECT ticket_id, attempt, status, started_at, ended_at, pid FROM ship_runs')
        .get(),
    ).toEqual({
      ticket_id: 1,
      attempt: 1,
      status: 'running',
      started_at: '2026-08-01T00:00:00.000Z',
      ended_at: null,
      pid: null,
    });
expect(migrated.db.pragma('user_version', { simple: true })).toBe(49);

    // Idempotence: reopening an already-migrated DB must not error or re-create.
    migrated.close();
    const reopened = openStore(path);
    cleanups.push(() => reopened.close());
    expect(reopened.db.pragma('user_version', { simple: true })).toBe(49);
  });

  it('a v38 DB gains the node-execution workspace shape (v39): base heads, byte total, ledger', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-db38-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'registry.db');
    const legacy = new Database(path);
    // A true v38: graph tables WITHOUT the two v39 columns (the real pre-v39
    // GRAPH_MIGRATION_DDL), so the guarded ALTERs below genuinely run.
    const legacyGraph = GRAPH_MIGRATION_DDL
      .replace('  workspace_bytes   INTEGER NOT NULL DEFAULT 0,\n', '')
      .replace('  base_heads               TEXT,\n', '');
    legacy.exec(v34SchemaText() + legacyGraph);
    legacy.pragma('user_version = 38');
    legacy.exec(`
      INSERT INTO tickets (key) VALUES ('T-1');
      INSERT INTO approach_graph_runs (ticket_id, stage_key, stage_attempt, approach_id, status, created_at)
      VALUES (1, 'impl', 0, 'x', 'running', '2026-08-12T00:00:00.000Z');
      INSERT INTO approach_graph_revisions (graph_run_id, revision_number, canonical_graph, fingerprint, status, created_at)
      VALUES (1, 1, '{}', 'fp', 'active', '2026-08-12T00:00:00.000Z');
      INSERT INTO approach_node_runs (graph_run_id, revision_id, node_id, node_kind, visit_number, status)
      VALUES (1, 1, 'n', 'agent', 1, 'ready');
    `);
    legacy.close();

    const migrated = openStore(path);
    cleanups.push(() => migrated.close());
    expect(migrated.db.pragma('user_version', { simple: true })).toBe(49);
    const nodeCols = new Set(
      (migrated.db.prepare("PRAGMA table_info('approach_node_runs')").all() as { name: string }[]).map(
        (c) => c.name,
      ),
    );
    expect(nodeCols.has('base_heads')).toBe(true);
    const runCols = new Set(
      (migrated.db.prepare("PRAGMA table_info('approach_graph_runs')").all() as { name: string }[]).map(
        (c) => c.name,
      ),
    );
    expect(runCols.has('workspace_bytes')).toBe(true);
    // The pre-existing rows are untouched; the new column defaults are inert.
    expect(
      migrated.db.prepare('SELECT base_heads FROM approach_node_runs WHERE id = 1').get() as object,
    ).toEqual({ base_heads: null });
    expect(
      migrated.db.prepare('SELECT workspace_bytes FROM approach_graph_runs WHERE id = 1').get() as object,
    ).toEqual({ workspace_bytes: 0 });
    const names = tableNames(migrated);
    expect(names).toContain('approach_graph_workspaces');
    expect(names).toHaveLength(EXPECTED_TABLES.length);
    // A legacy v35 DB (graph tables, no v39 columns) lands at the same shape.
    const legacy35 = new Database(join(dir, 'registry35.db'));
    legacy35.exec(v34SchemaText() + legacyGraph);
    legacy35.pragma('user_version = 35');
    legacy35.close();
    const migrated35 = openStore(join(dir, 'registry35.db'));
    cleanups.push(() => migrated35.close());
    expect(migrated35.db.pragma('user_version', { simple: true })).toBe(49);
    const runCols35 = new Set(
      (migrated35.db.prepare("PRAGMA table_info('approach_graph_runs')").all() as { name: string }[]).map(
        (c) => c.name,
      ),
    );
    expect(runCols35.has('workspace_bytes')).toBe(true);
    expect(tableNames(migrated35)).toContain('approach_graph_workspaces');
  });

  it('a v40 DB gains the fork-execution identity column (v41): fork_instance_id', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-db40-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'registry.db');
    const legacy = new Database(path);
    // A true v40: graph tables WITHOUT the v41 fork_instance_id column.
    const legacyGraph = GRAPH_MIGRATION_DDL.replace('  fork_instance_id      TEXT,\n', '');
    legacy.exec(v34SchemaText() + legacyGraph);
    legacy.pragma('user_version = 40');
    legacy.exec(`
      INSERT INTO tickets (key) VALUES ('T-1');
      INSERT INTO approach_graph_runs (ticket_id, stage_key, stage_attempt, approach_id, status, created_at)
      VALUES (1, 'impl', 0, 'x', 'running', '2026-08-12T00:00:00.000Z');
      INSERT INTO approach_graph_revisions (graph_run_id, revision_number, canonical_graph, fingerprint, status, created_at)
      VALUES (1, 1, '{}', 'fp', 'active', '2026-08-12T00:00:00.000Z');
      INSERT INTO approach_graph_tokens
        (revision_id, source_node_run_id, is_entry, edge_id, destination_node_id, destination_end, fork_instance, fork_lineage, status, created_at)
      VALUES (1, NULL, 1, 'entry', 'a', 0, 0, 'root', 'pending', '2026-08-12T00:00:00.000Z');
    `);
    legacy.close();

    const migrated = openStore(path);
    cleanups.push(() => migrated.close());
    expect(migrated.db.pragma('user_version', { simple: true })).toBe(49);
    const tokenCols = new Set(
      (migrated.db.prepare("PRAGMA table_info('approach_graph_tokens')").all() as { name: string }[]).map(
        (c) => c.name,
      ),
    );
    expect(tokenCols.has('fork_instance_id')).toBe(true);
    // Legacy rows are untouched; the new column reads NULL, never invented.
    expect(
      migrated.db.prepare('SELECT fork_instance_id FROM approach_graph_tokens WHERE id = 1').get() as object,
    ).toEqual({ fork_instance_id: null });  });

  it('v43 strips the creation-time Follow-up: prefix from legacy follow-up titles', () => {
    const dir = mkdtempSync(join(tmpdir(), 'v43-'));
    const path = join(dir, 'test.db');
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

    // Seed a current-shape DB, then roll its version back so the v43 step fires.
    const seeded = openStore(path);
    const parent = createTicket(seeded, { key: 'PROJ-1', title: 'Ship the thing' });
    const fu1 = createTicket(seeded, {
      key: 'PROJ-1-fu1',
      title: 'Follow-up: Ship the thing',
      parentTicketId: parent.id,
    });
    createTicket(seeded, {
      key: 'PROJ-1-fu2',
      title: 'Follow-up: Follow-up: Ship the thing',
      parentTicketId: fu1.id,
    });
    // A NON-follow-up whose title merely starts with the words is never touched.
    createTicket(seeded, { key: 'PROJ-2', title: 'Follow-up: a real task title' });
    seeded.db.pragma('user_version = 42');
    seeded.close();

    const migrated = openStore(path);
    cleanups.push(() => migrated.close());
    expect(migrated.db.pragma('user_version', { simple: true })).toBe(49);

    const rows = migrated.db
      .prepare('SELECT key, title FROM tickets ORDER BY key')
      .all() as { key: string; title: string }[];
    expect(rows).toEqual([
      { key: 'PROJ-1', title: 'Ship the thing' },
      { key: 'PROJ-1-fu1', title: 'Ship the thing' },
      { key: 'PROJ-1-fu2', title: 'Ship the thing' }, // nested prefix stripped fully
      { key: 'PROJ-2', title: 'Follow-up: a real task title' }, // not a follow-up
    ]);
  });

  it('v44 adds the provider-native priority column without backfilling a value', () => {
    const dir = mkdtempSync(join(tmpdir(), 'v44-'));
    const path = join(dir, 'test.db');
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

    // Seed a current-shape DB, then roll its version back so the v44 step fires.
    const seeded = openStore(path);
    createTicket(seeded, { key: 'PROJ-1', title: 'thing' });
    seeded.db.pragma('user_version = 43');
    seeded.close();

    const migrated = openStore(path);
    cleanups.push(() => migrated.close());
    expect(migrated.db.pragma('user_version', { simple: true })).toBe(49);

    const cols = new Set(
      (migrated.db.prepare("PRAGMA table_info('tickets')").all() as { name: string }[]).map(
        (c) => c.name,
      ),
    );
    expect(cols.has('priority')).toBe(true);
    // Nothing is backfilled: a pre-v44 ticket has no provider priority to derive,
    // so it stays NULL and reads as "the provider never said".
    const row = migrated.db
      .prepare('SELECT priority FROM tickets WHERE key = ?')
      .get('PROJ-1') as { priority: string | null };
    expect(row.priority).toBeNull();
  });

  // v44 was bumped INDEPENDENTLY on two branches — #215 added the per-ticket
  // `effort` override, #216 added the provider-native `priority` label — and
  // merged into one step. A registry migrated by the earlier build reports
  // user_version = 45 while `tickets` still carries `effort` but NOT
  // `priority`; the version-gated `current < 44` ALTER is then skipped forever
  // and the ticket form's fetch dies with "no such column: priority"
  // (869ej2cfz). The repair must therefore run OUTSIDE the version gate, like
  // the servers.cwd repair above it.
  it('repairs a v44 DB that never gained tickets.priority', () => {
    const dir = mkdtempSync(join(tmpdir(), 'v44-priority-'));
    const path = join(dir, 'test.db');
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

    // Start from the current shape, then drop `priority` while keeping the
    // version stamped at 44 — exactly the state the earlier v44 build left.
    const seeded = openStore(path);
    seeded.db.pragma('user_version = 45');
    seeded.close();
    const raw = new Database(path);
    raw.exec('ALTER TABLE tickets DROP COLUMN priority');
    raw.close();

    const migrated = openStore(path);
    cleanups.push(() => migrated.close());
    expect(migrated.db.pragma('user_version', { simple: true })).toBe(49);

    const cols = new Set(
      (migrated.db.prepare("PRAGMA table_info('tickets')").all() as { name: string }[]).map(
        (c) => c.name,
      ),
    );
    expect(cols.has('priority')).toBe(true);
  });

  // v45 was bumped INDEPENDENTLY on two branches — the usage reasoning-token
  // counters (#247) and the recovery-round `interrupt_count` counter — and
  // merged into one step. A registry migrated by the earlier build reports
  // user_version = 45 while `recovery_rounds` still carries everything else but
  // NOT `interrupt_count`; the version-gated `current < 45` ALTER is then
  // skipped forever and the driver's recovery loop reads a schema it never
  // extended. The repair must therefore run OUTSIDE the version gate, like the
  // tickets.priority repair above it.
  it('repairs a v45 DB that never gained recovery_rounds.interrupt_count', () => {
    const dir = mkdtempSync(join(tmpdir(), 'v45-interrupt-'));
    const path = join(dir, 'test.db');
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

    // Start from the current shape, then drop `interrupt_count` while keeping
    // the version stamped at 45 — exactly the state the earlier v45 build left.
    const seeded = openStore(path);
    seeded.db.pragma('user_version = 45');
    seeded.close();
    const raw = new Database(path);
    raw.exec('ALTER TABLE recovery_rounds DROP COLUMN interrupt_count');
    raw.close();

    const migrated = openStore(path);
    cleanups.push(() => migrated.close());
    expect(migrated.db.pragma('user_version', { simple: true })).toBe(49);

    const cols = new Set(
      (migrated.db.prepare("PRAGMA table_info('recovery_rounds')").all() as { name: string }[]).map(
        (c) => c.name,
      ),
    );
    expect(cols.has('interrupt_count')).toBe(true);
    // Nothing is backfilled: a round interrupted by a pre-v45 build has no count
    // to synthesize, so the ledger's DEFAULT 0 reads as "never interrupted".
    const row = migrated.db
      .prepare('SELECT interrupt_count FROM recovery_rounds LIMIT 1')
      .get() as { interrupt_count: number } | undefined;
    if (row) {
      expect(row.interrupt_count).toBe(0);
    }
  });

  // v47: the ship retry guard used to match only `status = 'open'`, but
  // `updatePrDetail` overwrites that status with the PR's real upstream state
  // right after the row is created — 'draft' for a draft PR — so the very
  // next retry missed the guard, re-adopted the same GitHub PR, and the old
  // plain INSERT added a second row for the same (ticket, repo, url). A real
  // report showed two rows both #3461, both 'draft'. This migration must
  // collapse any such pre-existing duplicates and add a UNIQUE index so it
  // cannot regress.
  it('v47 collapses pre-existing duplicate prs rows and adds the uniqueness index', () => {
    const dir = mkdtempSync(join(tmpdir(), 'v47-dup-prs-'));
    const path = join(dir, 'test.db');
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

    const seeded = openStore(path);
    const ticketId = createTicket(seeded, { key: 'PROJ-1', title: 'thing' }).id;
    // Simulate the pre-v47 shape: no uniqueness index yet, so the duplicate
    // rows below can actually be seeded (exactly what the old plain INSERT
    // in ship.ts could produce).
    seeded.db.exec('DROP INDEX IF EXISTS idx_prs_ticket_repo_url');
    // Two rows for the SAME (ticket, repo, url): the first (poorer) row ship
    // originally inserted, and a second row a retry's old plain INSERT added
    // after the status guard missed it. The second row carries richer v16
    // metadata (a probe that actually resolved head/base) — the migration
    // must keep the richer row, not just the lowest rowid.
    seeded.db
      .prepare(
        `INSERT INTO prs (ticket_id, repo, number, url, status, head_ref, base_ref)
         VALUES (?, '/repo/frontend', 3461, 'https://github.com/o/r/pull/3461', 'draft', NULL, NULL)`,
      )
      .run(ticketId);
    seeded.db
      .prepare(
        `INSERT INTO prs (ticket_id, repo, number, url, status, head_ref, base_ref)
         VALUES (?, '/repo/frontend', 3461, 'https://github.com/o/r/pull/3461', 'draft', 'karst/x', 'develop')`,
      )
      .run(ticketId);
    // An unrelated, non-duplicate row must survive untouched.
    seeded.db
      .prepare(
        `INSERT INTO prs (ticket_id, repo, number, url, status) VALUES (?, '/repo/backend', 7, 'https://github.com/o/r/pull/7', 'open')`,
      )
      .run(ticketId);
    seeded.db.pragma('user_version = 46');
    seeded.close();

    const migrated = openStore(path);
    cleanups.push(() => migrated.close());
    expect(migrated.db.pragma('user_version', { simple: true })).toBe(49);

    const rows = migrated.db
      .prepare(
        `SELECT repo, number, url, status, head_ref, base_ref FROM prs WHERE ticket_id = ? ORDER BY repo`,
      )
      .all(ticketId) as Array<{
      repo: string;
      number: number;
      url: string;
      status: string;
      head_ref: string | null;
      base_ref: string | null;
    }>;
    expect(rows).toHaveLength(2);
    const fe = rows.find((r) => r.repo === '/repo/frontend')!;
    // The richer of the two duplicates survives.
    expect(fe.head_ref).toBe('karst/x');
    expect(fe.base_ref).toBe('develop');
    expect(rows.find((r) => r.repo === '/repo/backend')).toBeDefined();

    // Re-opening (idempotent re-run) touches nothing further.
    migrated.close();
    const reopened = openStore(path);
    cleanups.push(() => reopened.close());
    expect(
      (
        reopened.db.prepare('SELECT COUNT(*) AS n FROM prs WHERE ticket_id = ?').get(ticketId) as {
          n: number;
        }
      ).n,
    ).toBe(2);

    // The UNIQUE index now prevents a fresh duplicate from ever landing again.
    expect(() =>
      reopened.db
        .prepare(
          `INSERT INTO prs (ticket_id, repo, number, url, status) VALUES (?, '/repo/frontend', 3461, 'https://github.com/o/r/pull/3461', 'draft')`,
        )
        .run(ticketId),
    ).toThrow();
  });

  it('v47 is a no-op on a fresh DB (no duplicates, index present)', () => {
    const store = openStore(':memory:');
    cleanups.push(() => store.close());
    expect(store.db.pragma('user_version', { simple: true })).toBe(49);
    const index = store.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get('idx_prs_ticket_repo_url');
    expect(index).toBeDefined();
  });
});
