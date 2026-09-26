import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openStore } from './db.js';
import { createTicket } from './tickets.js';
import { getDisabledGates, setDisabledGates } from './ticketGates.js';

function ticket(store: ReturnType<typeof openStore>): number {
  return createTicket(store, { key: 'K-1', title: 'A ticket', source: 'manual' }).id;
}

describe('ticketGates', () => {
  it('reads empty lists for a ticket that has disabled nothing', () => {
    const store = openStore(':memory:');
    expect(getDisabledGates(store, ticket(store))).toEqual({ uat: [], review: [] });
  });

  it('round-trips one stage', () => {
    const store = openStore(':memory:');
    const id = ticket(store);
    setDisabledGates(store, id, 'uat', ['e2e']);
    expect(getDisabledGates(store, id)).toEqual({ uat: ['e2e'], review: [] });
  });

  it('writes only the named stage, leaving the other untouched', () => {
    const store = openStore(':memory:');
    const id = ticket(store);
    setDisabledGates(store, id, 'uat', ['e2e']);
    setDisabledGates(store, id, 'review', ['lint']);
    expect(getDisabledGates(store, id)).toEqual({ uat: ['e2e'], review: ['lint'] });
  });

  it('clears a stage back to empty without touching the other', () => {
    const store = openStore(':memory:');
    const id = ticket(store);
    setDisabledGates(store, id, 'uat', ['e2e']);
    setDisabledGates(store, id, 'review', ['lint']);
    setDisabledGates(store, id, 'uat', []);
    expect(getDisabledGates(store, id)).toEqual({ uat: [], review: ['lint'] });
  });

  it('deduplicates and drops blank names on write', () => {
    const store = openStore(':memory:');
    const id = ticket(store);
    setDisabledGates(store, id, 'uat', ['e2e', 'e2e', '  ', 'lint']);
    expect(getDisabledGates(store, id).uat).toEqual(['e2e', 'lint']);
  });

  it('degrades a corrupted column to empty lists instead of throwing', () => {
    const store = openStore(':memory:');
    const id = ticket(store);
    store.db.prepare('UPDATE tickets SET disabled_gates = ? WHERE id = ?').run('{not json', id);
    expect(getDisabledGates(store, id)).toEqual({ uat: [], review: [] });
  });

  it('ignores non-string entries and unknown stage keys in stored JSON', () => {
    const store = openStore(':memory:');
    const id = ticket(store);
    store.db
      .prepare('UPDATE tickets SET disabled_gates = ? WHERE id = ?')
      .run(JSON.stringify({ uat: ['e2e', 3, null], ship: ['nope'] }), id);
    expect(getDisabledGates(store, id)).toEqual({ uat: ['e2e'], review: [] });
  });

  it('is a no-op for an unknown ticket id', () => {
    const store = openStore(':memory:');
    setDisabledGates(store, 9999, 'uat', ['e2e']);
    expect(getDisabledGates(store, 9999)).toEqual({ uat: [], review: [] });
  });

  it('holds a write transaction across its read-modify-write, so a concurrent window cannot interleave (P2-03)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-gates-'));
    const path = join(dir, 'karst.db');
    const a = openStore(path);
    const b = openStore(path);
    try {
      b.db.pragma('busy_timeout = 0');
      const id = createTicket(a, { key: 'K-1', title: 'A ticket' }).id;
      let refused: unknown;
      const realPrepare = a.db.prepare.bind(a.db);
      (a.db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
        if (sql.includes('UPDATE tickets SET disabled_gates')) {
          // The concurrent window commits exactly between A's read and A's
          // write. With A's BEGIN IMMEDIATE held, it is refused.
          try {
            setDisabledGates(b, id, 'review', ['lint']);
          } catch (err) {
            refused = err;
          }
        }
        return realPrepare(sql);
      };

      setDisabledGates(a, id, 'uat', ['e2e']);

      expect(refused).toBeDefined();
      expect(String((refused as { code?: string }).code)).toContain('SQLITE_BUSY');
      expect(getDisabledGates(a, id)).toEqual({ uat: ['e2e'], review: [] });
    } finally {
      a.close();
      b.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
