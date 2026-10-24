import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStore, type Store } from './db.js';
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
