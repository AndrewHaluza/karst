import { describe, expect, it } from 'vitest';
import { openStore } from '../store/db.js';
import { hostSlotName, reallocateHostPort } from './sandboxHostPort.js';

describe('reallocateHostPort (arch:AC-32 conflict)', () => {
  it('draws a fresh host port that skips the taken one and every recorded allocation', () => {
    const store = openStore(':memory:');
    store.db.prepare("INSERT INTO port_allocations (ticket_id, repo, port_name, port) VALUES (7, 'api', 'http', 4100)").run();
    expect(reallocateHostPort(store, [4100, 4110], 7, 'api', 'http', 4101)).toBe(4102);
    expect(store.db.prepare('SELECT port_name AS n, port FROM port_allocations ORDER BY port').all()).toEqual([
      { n: 'http', port: 4100 }, { n: hostSlotName('http'), port: 4102 },
    ]);
  });

  it('replaces its own previous host record instead of accumulating', () => {
    const store = openStore(':memory:');
    reallocateHostPort(store, [4100, 4110], 7, 'api', 'http', 4100);
    reallocateHostPort(store, [4100, 4110], 7, 'api', 'http', 4101);
    expect(store.db.prepare("SELECT port FROM port_allocations WHERE port_name = 'http@host'").all()).toEqual([{ port: 4100 }]);
  });
});
