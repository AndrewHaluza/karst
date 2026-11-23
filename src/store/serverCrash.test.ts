import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from './db.js';
import { markServerCrashed } from './serverCrash.js';

interface Row {
  status: string;
  pid: number | null;
  lastError: string | null;
}

describe('markServerCrashed', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  const insert = (status: string, pid: number | null): number =>
    Number(
      store.db
        .prepare("INSERT INTO servers (ticket_id, repo, host, port, pid, status) VALUES (1, 'api', '127.0.0.1', 4000, ?, ?)")
        .run(pid, status).lastInsertRowid,
    );
  const read = (id: number): Row =>
    store.db.prepare('SELECT status, pid, last_error AS lastError FROM servers WHERE id = ?').get(id) as Row;

  it('marks a running row failed, clears its pid and stores the reason', () => {
    const id = insert('running', 4123);
    expect(markServerCrashed(store, id, 4123, 'Exited unexpectedly')).toBe(true);
    expect(read(id)).toEqual({ status: 'failed', pid: null, lastError: 'Exited unexpectedly' });
  });

  it('marks a pid-NULL running row (a container or sandbox row) when the pid argument is null', () => {
    const id = insert('running', null);
    expect(markServerCrashed(store, id, null, 'Exited unexpectedly')).toBe(true);
    expect(read(id).status).toBe('failed');
  });

  it('does nothing when the row is no longer running (a user Stop won the race)', () => {
    const id = insert('stopped', null);
    expect(markServerCrashed(store, id, null, 'Exited unexpectedly')).toBe(false);
    expect(read(id)).toEqual({ status: 'stopped', pid: null, lastError: null });
  });

  it('does nothing when the pid changed (a restart replaced the process)', () => {
    const id = insert('running', 5000);
    expect(markServerCrashed(store, id, 4123, 'Exited unexpectedly')).toBe(false);
    expect(read(id)).toEqual({ status: 'running', pid: 5000, lastError: null });
  });

  it('does nothing for an absent row', () => {
    expect(markServerCrashed(store, 999, 1, 'Exited unexpectedly')).toBe(false);
  });
});
