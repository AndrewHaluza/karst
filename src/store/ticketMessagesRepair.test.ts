import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openStore } from './db.js';
import { upsertProject } from './projects.js';
import { createTicket } from './tickets.js';
import { postMessage } from './ticketMessages.js';

/**
 * v64 shipped on this branch before `woke_at`/AUTOINCREMENT: a dev DB already
 * stamped 64 carries the early `ticket_messages` shape and must be repaired on
 * open without a version bump.
 */
const EARLY_V64 = `
  DROP TABLE ticket_messages;
  CREATE TABLE ticket_messages (
    id             INTEGER PRIMARY KEY,
    project_id     INTEGER REFERENCES projects(id) ON DELETE CASCADE,
    from_ticket_id INTEGER REFERENCES tickets(id) ON DELETE CASCADE,
    to_ticket_id   INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    kind           TEXT NOT NULL CHECK (kind IN ('message', 'event')),
    body           TEXT NOT NULL,
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    read_at        TEXT
  );
  CREATE INDEX idx_ticket_messages_inbox ON ticket_messages(to_ticket_id, read_at);`;

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function earlyV64Db(): { path: string; projectId: number; to: number } {
  const dir = mkdtempSync(join(tmpdir(), 'karst-msg-repair-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'karst.db');
  const s = openStore(path);
  const projectId = upsertProject(s, { slug: 'p' }).id;
  const to = createTicket(s, { key: 'P-1', title: 't', projectId }).id;
  s.close();
  const raw = new Database(path);
  raw.exec(EARLY_V64);
  raw.pragma('user_version = 64');
  raw.prepare(
    "INSERT INTO ticket_messages (project_id, to_ticket_id, kind, body) VALUES (?, ?, 'message', 'kept')",
  ).run(projectId, to);
  expect(raw.pragma('user_version', { simple: true })).toBe(64);
  raw.close();
  return { path, projectId, to };
}

describe('ticket_messages repair for DBs already at v64', () => {
  it('adds woke_at and the wake index, keeping rows', () => {
    const { path } = earlyV64Db();
    const s = openStore(path);
    cleanups.push(() => s.close());
    const cols = (s.db.prepare('PRAGMA table_info(ticket_messages)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain('woke_at');
    expect(s.db.prepare('SELECT body FROM ticket_messages').all()).toEqual([{ body: 'kept' }]);
    const idx = s.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='ticket_messages'").all();
    expect(idx).toEqual(
      expect.arrayContaining([{ name: 'idx_ticket_messages_inbox' }, { name: 'idx_ticket_messages_wake' }]),
    );
  });

  it('ids never reuse a deleted top row (AUTOINCREMENT)', () => {
    const { path, projectId, to } = earlyV64Db();
    const s = openStore(path);
    cleanups.push(() => s.close());
    const post = () => postMessage(s, { projectId, fromTicketId: null, toTicketId: to, kind: 'event', body: 'x' });
    const top = post();
    s.db.prepare('DELETE FROM ticket_messages WHERE id = ?').run(top.id);
    expect(post().id).toBeGreaterThan(top.id);
  });

  it('a fresh DB already has the repaired shape', () => {
    const s = openStore(':memory:');
    cleanups.push(() => s.close());
    const sql = (s.db.prepare("SELECT sql FROM sqlite_master WHERE name='ticket_messages'").get() as { sql: string }).sql;
    expect(sql).toMatch(/AUTOINCREMENT/i);
    expect(sql).toMatch(/woke_at/);
  });
});
