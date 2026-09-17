import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { makeRecordedPortAllocator, MissingAllocationError } from './recordedAllocator.js';

function record(store: Store, ticketId: number, repo: string, portName: string, port: number): void {
  store.db
    .prepare('INSERT INTO port_allocations (ticket_id, repo, port_name, port) VALUES (?, ?, ?, ?)')
    .run(ticketId, repo, portName, port);
}

describe('makeRecordedPortAllocator', () => {
  let store: Store;

  beforeEach(() => {
    store = openStore(':memory:');
  });
  afterEach(() => store.close());

  it('returns the recorded ports for a repo with two slots, in the requested slot order', () => {
    const alloc = makeRecordedPortAllocator(store, 1);
    record(store, 1, 'backend', 'http', 4001);
    record(store, 1, 'backend', 'debug', 4002);

    expect(alloc.allocate(1, 'backend', ['debug', 'http'])).toEqual({ debug: 4002, http: 4001 });
  });

  it('ignores the range-override argument entirely', () => {
    const alloc = makeRecordedPortAllocator(store, 1);
    record(store, 1, 'backend', 'http', 4001);

    expect(alloc.allocate(1, 'backend', ['http'], [1, 2])).toEqual({ http: 4001 });
  });

  it('returns {} for an empty slot list without touching the DB', () => {
    const alloc = makeRecordedPortAllocator(store, 1);
    let queried = false;
    (store.db as { prepare: (sql: string) => unknown }).prepare = () => {
      queried = true;
      throw new Error('should not query');
    };

    expect(alloc.allocate(1, 'backend', [])).toEqual({});
    expect(queried).toBe(false);
  });

  it('throws MissingAllocationError naming the repo and only the missing slots', () => {
    const alloc = makeRecordedPortAllocator(store, 1);
    record(store, 1, 'backend', 'http', 4001);

    let caught: unknown;
    try {
      alloc.allocate(1, 'backend', ['http', 'debug']);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MissingAllocationError);
    expect((caught as MissingAllocationError).repo).toBe('backend');
    expect((caught as MissingAllocationError).slots).toEqual(['debug']);
  });

  it('throws MissingAllocationError when the repo has no rows at all', () => {
    const alloc = makeRecordedPortAllocator(store, 1);

    let caught: unknown;
    try {
      alloc.allocate(1, 'backend', ['http']);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MissingAllocationError);
    expect((caught as MissingAllocationError).slots).toEqual(['http']);
  });

  it('does not insert: COUNT(*) is unchanged after a successful allocate', () => {
    const alloc = makeRecordedPortAllocator(store, 1);
    record(store, 1, 'backend', 'http', 4001);
    const before = (
      store.db.prepare('SELECT COUNT(*) AS n FROM port_allocations').get() as { n: number }
    ).n;

    alloc.allocate(1, 'backend', ['http']);

    const after = (
      store.db.prepare('SELECT COUNT(*) AS n FROM port_allocations').get() as { n: number }
    ).n;
    expect(after).toBe(before);
  });

  it('release() throws', () => {
    const alloc = makeRecordedPortAllocator(store, 1);
    expect(() => alloc.release(1)).toThrow();
  });
});
