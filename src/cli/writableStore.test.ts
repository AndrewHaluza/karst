import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../store/db.js';
import { createTicket, getTicket } from '../store/tickets.js';
import { transition } from '../workflow/machine.js';
import { openWritableStore } from './writableStore.js';

/**
 * The writable node:sqlite adapter must satisfy the exact `store.db` surface the
 * stage machine uses — `.prepare()` AND `.transaction()` — so the marker CLI can
 * advance a stage under plain `node` (no better-sqlite3 ABI addon).
 */
describe('openWritableStore', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'karst-wstore-'));
    dbPath = join(dir, 'karst.db');
    // Create + migrate the schema with better-sqlite3, then seed a ticket sitting
    // at impl, then close so the WAL file is flushed for the node:sqlite reader.
    const seed = openStore(dbPath);
    createTicket(seed, { key: 'K-1', title: 'demo' });
    transition(seed, 1, 'scope', { kind: 'passed' }); // scope -> impl (running)
    seed.close();
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('drives the machine transition(impl, passed) end-to-end', () => {
    const store = openWritableStore(dbPath);
    try {
      const next = transition(store, 1, 'impl', { kind: 'passed' });
      expect(next).toBe('uat');
    } finally {
      store.close();
    }

    // Reopen (readonly better-sqlite3) and confirm the write landed.
    const check = openStore(dbPath);
    const t = getTicket(check, 1);
    const impl = t.stages.find((s) => s.stageKey === 'impl');
    const uat = t.stages.find((s) => s.stageKey === 'uat');
    expect(impl?.status).toBe('passed');
    expect(uat?.status).toBe('running');
    check.close();
  });

  it('rolls back the whole transaction when the body throws', () => {
    const store = openWritableStore(dbPath);
    try {
      const boom = store.db.transaction(() => {
        store.db.prepare('UPDATE tickets SET title = ? WHERE id = ?').run('mutated', 1);
        throw new Error('boom');
      });
      expect(() => boom()).toThrow('boom');
    } finally {
      store.close();
    }

    const check = openStore(dbPath);
    const row = check.db.prepare('SELECT title FROM tickets WHERE id = ?').get(1) as { title: string };
    expect(row.title).toBe('demo'); // unchanged — rolled back
    check.close();
  });
});
