import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { databaseTimestampShift, rebaseDatabase, shiftTimestampText, type RebaseDb } from './rebase.js';

const NOW = Date.parse('2026-10-27T22:00:00.000Z');
const HOUR = 3_600_000;

function fixtureDb(): { db: DatabaseSync; rdb: RebaseDb } {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE tickets (id INTEGER PRIMARY KEY, updated_at TEXT, body TEXT);
    CREATE TABLE token_usage (id INTEGER PRIMARY KEY, recorded_at TEXT);
    CREATE TABLE schedules (id INTEGER PRIMARY KEY, reset_at TEXT, rerun_at INTEGER, wait_ms INTEGER);
  `);
  return { db, rdb: db as unknown as RebaseDb };
}

describe('databaseTimestampShift', () => {
  it('aligns the newest anchor timestamp with now, in ISO and SQLite form', () => {
    const { db, rdb } = fixtureDb();
    db.prepare('INSERT INTO tickets (updated_at) VALUES (?)').run('2026-11-26T10:00:00.000Z');
    db.prepare('INSERT INTO token_usage (recorded_at) VALUES (?)').run('2026-11-26 12:00:00');
    expect(databaseTimestampShift(rdb, NOW)).toBe(NOW - Date.parse('2026-11-26T12:00:00.000Z'));
  });

  it('ignores scheduled (future) columns, so they never steer the delta', () => {
    const { db, rdb } = fixtureDb();
    db.prepare('INSERT INTO tickets (updated_at) VALUES (?)').run('2026-11-26T10:00:00.000Z');
    db.prepare('INSERT INTO schedules (reset_at, rerun_at) VALUES (?, ?)').run('2026-12-30T00:00:00.000Z', Date.parse('2026-12-31T00:00:00.000Z'));
    expect(databaseTimestampShift(rdb, NOW)).toBe(NOW - Date.parse('2026-11-26T10:00:00.000Z'));
  });

  it('is 0 for a database without anchor timestamps', () => {
    expect(databaseTimestampShift(fixtureDb().rdb, NOW)).toBe(0);
  });
});

describe('rebaseDatabase', () => {
  it('moves text timestamps (also inside text), INTEGER *_at epoch ms, and never a *_ms duration', () => {
    const { db, rdb } = fixtureDb();
    db.prepare('INSERT INTO tickets (updated_at, body) VALUES (?, ?)').run('2026-11-26T10:00:00.000Z', '{"at":"2026-11-26 10:00:00.123"}');
    db.prepare('INSERT INTO schedules (reset_at, rerun_at, wait_ms) VALUES (?, ?, ?)').run('2026-11-26 10:00:00', Date.parse('2026-11-26T10:00:00Z'), 5_000);
    rebaseDatabase(rdb, -2 * HOUR);
    expect(db.prepare('SELECT updated_at, body FROM tickets').get()).toEqual({
      updated_at: '2026-11-26T08:00:00.000Z',
      body: '{"at":"2026-11-26 08:00:00.123"}',
    });
    expect(db.prepare('SELECT reset_at, rerun_at, wait_ms FROM schedules').get()).toEqual({
      reset_at: '2026-11-26 08:00:00',
      rerun_at: Date.parse('2026-11-26T08:00:00Z'),
      wait_ms: 5_000,
    });
  });

  it('changes nothing for a zero shift', () => {
    const { db, rdb } = fixtureDb();
    db.prepare('INSERT INTO tickets (updated_at) VALUES (?)').run('2026-11-26T10:00:00.000Z');
    rebaseDatabase(rdb, 0);
    expect(db.prepare('SELECT updated_at FROM tickets').get()).toEqual({ updated_at: '2026-11-26T10:00:00.000Z' });
  });
});

describe('shiftTimestampText', () => {
  it('keeps the format of each timestamp and leaves other text alone', () => {
    expect(shiftTimestampText('at 2026-01-02T03:04:05Z and 2026-01-02 03:04:05, id 2026', HOUR)).toBe(
      'at 2026-01-02T04:04:05.000Z and 2026-01-02 04:04:05, id 2026',
    );
  });
});
