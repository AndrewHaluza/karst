import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { recordFailedStart, portRefusalReason } from './supervisor.js';

const OPTS = {
  ticketId: 1,
  service: 'api',
  host: '127.0.0.1',
  port: 3000,
  logPath: '/l/api.log',
  cwd: '/w',
};

interface Row {
  status: string;
  pid: number | null;
  lastError: string | null;
}

describe('recordFailedStart', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  const rows = (): Row[] =>
    store.db
      .prepare("SELECT status, pid, last_error AS lastError FROM servers WHERE repo = 'api' ORDER BY id")
      .all() as Row[];

  it('replaces a prior stopped or failed row with one failed row that carries the reason', () => {
    store.db.prepare("INSERT INTO servers (ticket_id, repo, status) VALUES (1, 'api', 'stopped')").run();
    store.db.prepare("INSERT INTO servers (ticket_id, repo, status, last_error) VALUES (1, 'api', 'failed', 'old')").run();

    recordFailedStart(store, OPTS, 'Port 3000 in use by pid 4123');

    expect(rows()).toEqual([{ status: 'failed', pid: null, lastError: 'Port 3000 in use by pid 4123' }]);
  });

  it('keeps this service own running row (a refused kill) and adds no failed row', () => {
    store.db.prepare("INSERT INTO servers (ticket_id, repo, pid, status) VALUES (1, 'api', 4123, 'running')").run();

    recordFailedStart(store, OPTS, 'Port 3000 in use by pid 4123');

    expect(rows()).toEqual([{ status: 'running', pid: 4123, lastError: null }]);
  });
});

describe('portRefusalReason', () => {
  it('names the first pid that holds the port', () => {
    expect(portRefusalReason(3000, [{ pid: 4123, baseline: false }], [])).toBe('Port 3000 in use by pid 4123');
  });

  it('names a shared service that holds the port', () => {
    expect(portRefusalReason(3000, [{ pid: 77, baseline: true }], [])).toBe('Port 3000 in use by a shared service');
  });

  it('names a process that karst cannot identify', () => {
    expect(portRefusalReason(3000, [{ pid: null, baseline: false }], [])).toBe('Port 3000 in use by another process');
  });

  it('names a killed pid whose socket has not released', () => {
    expect(portRefusalReason(3000, [], [4123])).toBe('Port 3000 in use by pid 4123');
  });

  it('falls back to a plain text when nothing is known', () => {
    expect(portRefusalReason(3000, [], [])).toBe('Port 3000 in use');
  });
});
