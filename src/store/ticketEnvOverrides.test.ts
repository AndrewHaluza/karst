import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openStore, type Store } from './db.js';
import { createTicket } from './tickets.js';
import {
  ALL_SERVICES,
  getEnvOverrides,
  setServiceEnvOverrides,
  envOverridesForService,
  isValidEnvKey,
} from './ticketEnvOverrides.js';

describe('ticket env overrides', () => {
  let store: Store;
  let ticketId: number;

  beforeEach(() => {
    store = openStore(':memory:');
    ticketId = createTicket(store, { key: 'T-1', title: 'env' }).id;
  });
  afterEach(() => store.db.close());

  it('reads empty for a ticket that never set one', () => {
    expect(getEnvOverrides(store, ticketId)).toEqual({});
  });

  it('reads empty for an unknown ticket id', () => {
    expect(getEnvOverrides(store, 987654)).toEqual({});
  });

  it('round-trips one service scope', () => {
    setServiceEnvOverrides(store, ticketId, 'api', { APP_HISTORY_FEATURE: 'true' });
    expect(getEnvOverrides(store, ticketId)).toEqual({ api: { APP_HISTORY_FEATURE: 'true' } });
  });

  it('replaces only the named scope, leaving the others', () => {
    setServiceEnvOverrides(store, ticketId, 'api', { A: '1' });
    setServiceEnvOverrides(store, ticketId, 'web', { B: '2' });
    setServiceEnvOverrides(store, ticketId, 'api', { A: '9', C: '3' });
    expect(getEnvOverrides(store, ticketId)).toEqual({
      api: { A: '9', C: '3' },
      web: { B: '2' },
    });
  });

  it('drops a scope set to nothing, and stores NULL once every scope is empty', () => {
    setServiceEnvOverrides(store, ticketId, 'api', { A: '1' });
    setServiceEnvOverrides(store, ticketId, 'api', {});
    expect(getEnvOverrides(store, ticketId)).toEqual({});
    const row = store.db
      .prepare('SELECT env_overrides FROM tickets WHERE id = ?')
      .get(ticketId) as { env_overrides: string | null };
    expect(row.env_overrides).toBeNull();
  });

  it('keeps the all-services scope under its own key', () => {
    setServiceEnvOverrides(store, ticketId, ALL_SERVICES, { SHARED: 'yes' });
    expect(getEnvOverrides(store, ticketId)).toEqual({ [ALL_SERVICES]: { SHARED: 'yes' } });
  });

  it('trims keys and rejects the ones that are not env identifiers', () => {
    setServiceEnvOverrides(store, ticketId, 'api', {
      '  GOOD_1 ': 'v',
      'bad-key': 'v',
      '1LEADING': 'v',
      '': 'v',
    });
    expect(getEnvOverrides(store, ticketId)).toEqual({ api: { GOOD_1: 'v' } });
  });

  it('coerces a non-string value to empty rather than storing it', () => {
    setServiceEnvOverrides(store, ticketId, 'api', {
      OK: 'v',
      NUM: 7 as unknown as string,
    });
    expect(getEnvOverrides(store, ticketId)).toEqual({ api: { OK: 'v', NUM: '' } });
  });

  it('degrades a corrupted column to no overrides', () => {
    store.db.prepare('UPDATE tickets SET env_overrides = ? WHERE id = ?').run('{not json', ticketId);
    expect(getEnvOverrides(store, ticketId)).toEqual({});
    store.db.prepare('UPDATE tickets SET env_overrides = ? WHERE id = ?').run('[1,2]', ticketId);
    expect(getEnvOverrides(store, ticketId)).toEqual({});
    store.db
      .prepare('UPDATE tickets SET env_overrides = ? WHERE id = ?')
      .run('{"api":"nope","web":{"A":"1"}}', ticketId);
    expect(getEnvOverrides(store, ticketId)).toEqual({ web: { A: '1' } });
  });

  it('flattens the all-services scope under the service scope', () => {
    const overrides = {
      [ALL_SERVICES]: { SHARED: 'a', BOTH: 'shared' },
      api: { OWN: 'b', BOTH: 'own' },
    };
    expect(envOverridesForService(overrides, 'api')).toEqual({
      SHARED: 'a',
      BOTH: 'own',
      OWN: 'b',
    });
    expect(envOverridesForService(overrides, 'web')).toEqual({ SHARED: 'a', BOTH: 'shared' });
    expect(envOverridesForService({}, 'web')).toEqual({});
  });

  it('holds a write transaction across its read-modify-write, so a concurrent window cannot interleave (P2-03)', () => {
    // Two connections on one file are two IDE windows on one shared registry.
    const dir = mkdtempSync(join(tmpdir(), 'karst-env-'));
    const path = join(dir, 'karst.db');
    const a = openStore(path);
    const b = openStore(path);
    try {
      b.db.pragma('busy_timeout = 0');
      const id = createTicket(a, { key: 'T-1', title: 'env' }).id;
      let refused: unknown;
      const realPrepare = a.db.prepare.bind(a.db);
      (a.db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
        if (sql.includes('UPDATE tickets SET env_overrides')) {
          // The concurrent window commits exactly between A's read and A's
          // write. With A's BEGIN IMMEDIATE held, it is refused; without the
          // transaction it would win and A's stale write would erase it.
          try {
            setServiceEnvOverrides(b, id, 'web', { B: '2' });
          } catch (err) {
            refused = err;
          }
        }
        return realPrepare(sql);
      };

      setServiceEnvOverrides(a, id, 'api', { A: '1' });

      expect(refused).toBeDefined();
      expect(String((refused as { code?: string }).code)).toContain('SQLITE_BUSY');
      expect(getEnvOverrides(a, id)).toEqual({ api: { A: '1' } });
    } finally {
      a.close();
      b.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('validates env key shape', () => {
    expect(isValidEnvKey('A')).toBe(true);
    expect(isValidEnvKey('_a1')).toBe(true);
    expect(isValidEnvKey('a-b')).toBe(false);
    expect(isValidEnvKey('1a')).toBe(false);
    expect(isValidEnvKey('')).toBe(false);
  });
});
