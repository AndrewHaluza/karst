import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { makePortAllocator, type PortAllocator } from './allocator.js';

describe('makePortAllocator', () => {
  let store: Store;
  let alloc: PortAllocator;

  beforeEach(() => {
    store = openStore(':memory:');
    alloc = makePortAllocator(store, [4000, 4010]);
  });
  afterEach(() => store.close());

  it('allocates contiguous ports per service', () => {
    const ports = alloc.allocate(1, 'backend', ['http', 'debug']);
    const values = Object.values(ports).sort((a, b) => a - b);
    expect(values).toHaveLength(2);
    expect(values[1]! - values[0]!).toBe(1); // contiguous
    expect(ports.http).toBeGreaterThanOrEqual(4000);
    expect(ports.debug).toBeGreaterThanOrEqual(4000);
  });

  it('never returns overlapping ports across two tickets', () => {
    const a = alloc.allocate(1, 'frontend', ['http']);
    const b = alloc.allocate(2, 'frontend', ['http']);
    expect(a.http).not.toBe(b.http);
  });

  it('never overlaps across many allocations', () => {
    const seen = new Set<number>();
    for (let t = 1; t <= 5; t++) {
      const ports = alloc.allocate(t, 'svc', ['http']);
      for (const p of Object.values(ports)) {
        expect(seen.has(p), `port ${p} allocated twice`).toBe(false);
        seen.add(p);
      }
    }
  });

  it('persists allocations to port_allocations', () => {
    alloc.allocate(1, 'backend', ['http']);
    const row = store.db
      .prepare('SELECT port FROM port_allocations WHERE ticket_id = ? AND port_name = ?')
      .get(1, 'http') as { port: number } | undefined;
    expect(row?.port).toBeGreaterThanOrEqual(4000);
  });

  it('release frees a ticket\'s ports for reuse', () => {
    const a = alloc.allocate(1, 'frontend', ['http']);
    alloc.release(1);
    const rows = store.db
      .prepare('SELECT COUNT(*) AS n FROM port_allocations WHERE ticket_id = ?')
      .get(1) as { n: number };
    expect(rows.n).toBe(0);

    // the freed block is reusable
    const b = alloc.allocate(2, 'frontend', ['http']);
    expect(b.http).toBe(a.http);
  });

  it('reuses the lowest free contiguous block', () => {
    alloc.allocate(1, 'a', ['http']); // 4000
    alloc.allocate(2, 'b', ['http']); // 4001
    alloc.release(1); // frees 4000
    const c = alloc.allocate(3, 'c', ['http']);
    expect(c.http).toBe(4000); // lowest free wins
  });

  it('throws a clear error when the range is exhausted', () => {
    const small = makePortAllocator(store, [4000, 4001]); // 2 ports
    small.allocate(1, 'a', ['http', 'debug']); // uses both
    expect(() => small.allocate(2, 'b', ['http'])).toThrow(/exhaust|no .*free|range/i);
  });

  it('finds a contiguous block skipping a fragmented gap', () => {
    const tight = makePortAllocator(store, [4000, 4003]); // 4 ports
    tight.allocate(1, 'a', ['http']); // 4000
    tight.allocate(2, 'b', ['http']); // 4001
    // need 2 contiguous: 4002-4003 free -> should get them
    const c = tight.allocate(3, 'c', ['http', 'debug']);
    const vals = Object.values(c).sort((x, y) => x - y);
    expect(vals).toEqual([4002, 4003]);
  });

  it('rejects when no contiguous block of the needed size exists', () => {
    const tight = makePortAllocator(store, [4000, 4002]); // 3 ports
    tight.allocate(1, 'a', ['http']); // 4000
    tight.allocate(2, 'b', ['http']); // 4001
    // free: only 4002 (size 1); asking for 2 contiguous must fail
    expect(() => tight.allocate(3, 'c', ['http', 'debug'])).toThrow(/exhaust|contiguous|no .*free|range/i);
  });
});
