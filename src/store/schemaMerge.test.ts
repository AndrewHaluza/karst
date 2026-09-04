import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openStore } from './db.js';
import { readSchema } from './migrations.js';

describe('merged schema migration', () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

  it('a develop-v35 DB (test tables, no graph) gains graph tables and lands at 42', () => {
    const dir = mkdtempSync(join(tmpdir(), 'verify-merge-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'registry.db');
    // v34 base WITHOUT the graph DDL (the pre-graph shape) + test tables = develop's v35.
    const base = readSchema().split('-- v38 (Slice 4 Task 6)')[0]!;
    const db = new Database(path);
    db.exec(base);
    db.exec(`
      CREATE TABLE IF NOT EXISTS test_logs (id INTEGER PRIMARY KEY, ticket_id INTEGER, level TEXT NOT NULL, module TEXT NOT NULL, message TEXT NOT NULL, meta TEXT, recorded_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_test_logs_ticket ON test_logs(ticket_id, id);
      CREATE TABLE IF NOT EXISTS test_hooks (id INTEGER PRIMARY KEY, ticket_id INTEGER, event TEXT NOT NULL, session_id TEXT, payload TEXT, agent_state_after TEXT, recorded_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_test_hooks_ticket ON test_hooks(ticket_id, id);
    `);
    db.pragma('user_version = 35');
    db.close();

    const store = openStore(path);
    cleanups.push(() => store.close());
    const version = store.db.pragma('user_version', { simple: true }) as number;
    const tables = store.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(version).toBe(55);
    expect(tables).toContain('approach_graph_runs');
    expect(tables).toContain('approach_graph_tokens');
    expect(tables).toContain('test_logs');
    expect(tables).toContain('test_hooks');
    expect(tables).not.toContain('ticket_logs');
  });
});
