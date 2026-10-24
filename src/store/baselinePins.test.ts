import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { openStore, type Store } from './db.js';
import { migrate } from './migrations.js';
import { SCHEMA_VERSION } from './schemaVersion.js';
import { listPinnedBaselines, pinBaseline, unpinBaseline } from './baselinePins.js';

describe('baseline pins', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  it('pins by unit key, idempotently', () => {
    pinBaseline(store, 'api');
    pinBaseline(store, 'api');
    pinBaseline(store, 'web/ui');
    expect([...listPinnedBaselines(store)].sort()).toEqual(['api', 'web/ui']);
  });

  it('keeps the first created_at when pinned twice', () => {
    pinBaseline(store, 'api');
    store.db.prepare("UPDATE baseline_pins SET created_at = 'first' WHERE repo = 'api'").run();
    pinBaseline(store, 'api');
    expect(store.db.prepare('SELECT created_at FROM baseline_pins').get()).toEqual({ created_at: 'first' });
  });

  it('unpin drops the key and tolerates an unpinned one', () => {
    pinBaseline(store, 'api');
    unpinBaseline(store, 'api');
    unpinBaseline(store, 'api');
    expect(listPinnedBaselines(store).size).toBe(0);
  });

  it('survives the servers row being deleted and reinserted (startHot)', () => {
    pinBaseline(store, 'api');
    store.db.prepare("INSERT INTO servers (ticket_id, repo, status) VALUES (NULL, 'api', 'running')").run();
    store.db.prepare("DELETE FROM servers WHERE repo = 'api'").run();
    expect(listPinnedBaselines(store).has('api')).toBe(true);
  });
});

describe('v89 migration', () => {
  it('adds baseline_pins to a v88 database, keeps its data, and is idempotent', () => {
    const db = new Database(':memory:');
    migrate(db);
    db.exec('DROP TABLE baseline_pins');
    db.pragma('user_version = 88');
    db.prepare("INSERT INTO servers (ticket_id, repo, status) VALUES (NULL, 'api', 'running')").run();

    migrate(db);
    migrate(db);

    expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBe(89);
    expect(db.prepare("SELECT COUNT(*) AS n FROM servers").get()).toEqual({ n: 1 });
    const cols = db.prepare('PRAGMA table_info(baseline_pins)').all() as { name: string; pk: number }[];
    expect(cols.map((c) => [c.name, c.pk])).toEqual([['repo', 1], ['created_at', 0]]);
    db.close();
  });
});
