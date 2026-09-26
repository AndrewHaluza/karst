import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../store/db.js';
import { createTicket, getTicket } from '../store/tickets.js';
import { transition } from '../workflow/machine.js';
import { insertAttachment } from '../store/attachments.js';
import { openWritableStore, MARKER_BUSY_TIMEOUT_MS } from './writableStore.js';

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

  it('sets a non-zero busy_timeout so a marker write waits out a lock instead of failing instantly', () => {
    const store = openWritableStore(dbPath);
    try {
      const row = store.db.prepare('PRAGMA busy_timeout').get() as { timeout: number };
      expect(row.timeout).toBe(MARKER_BUSY_TIMEOUT_MS);
    } finally {
      store.close();
    }
  });

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

  it('refuses a nested store.db.transaction() with a named error instead of a bare SQLite parse failure (NDL-35)', () => {
    const store = openWritableStore(dbPath);
    try {
      const outer = store.db.transaction(() => {
        const inner = store.db.transaction(() => {
          store.db.prepare('UPDATE tickets SET title = ? WHERE id = ?').run('mutated', 1);
        });
        inner();
      });
      // better-sqlite3 would nest this as a SAVEPOINT; this flat CLI shim cannot,
      // and must say so rather than surface SQLite's generic parse error.
      expect(() => outer()).toThrow(/nested store\.db\.transaction\(\) is not supported/);
    } finally {
      store.close();
    }

    const check = openStore(dbPath);
    const row = check.db.prepare('SELECT title FROM tickets WHERE id = ?').get(1) as { title: string };
    expect(row.title).toBe('demo'); // the outer transaction rolled back too
    check.close();
  });

  it('offers better-sqlite-compatible immediate transactions that lock before the body', () => {
    const store = openWritableStore(dbPath);
    let contenderWasBlocked = false;
    try {
      const transaction = store.db.transaction(() => {
        const contender = spawnSync(
          process.execPath,
          [
            '-e',
            `const { DatabaseSync } = require('node:sqlite');
             const db = new DatabaseSync(process.argv[1]);
             db.exec('PRAGMA busy_timeout = 0');
             try {
               db.prepare('UPDATE tickets SET title = ? WHERE id = 1').run('contender');
               db.close();
               process.exit(0);
             } catch (err) {
               console.error(err instanceof Error ? err.message : String(err));
               db.close();
               process.exit(2);
             }`,
            dbPath,
          ],
          { encoding: 'utf8' },
        );
        contenderWasBlocked =
          contender.status === 2 && /busy|locked/i.test(contender.stderr);
      });

      transaction.immediate();

      expect(contenderWasBlocked).toBe(true);
    } finally {
      store.close();
    }
  });

  it('runs the attachment conditional dedupe upsert through node:sqlite', () => {
    const store = openWritableStore(dbPath);
    try {
      const input = {
        ticketId: 1,
        kind: 'image' as const,
        storedName: 'same.png',
        originalName: 'first.png',
        byteSize: 4,
      };
      const inserted = insertAttachment(store, input);
      const deduped = insertAttachment(store, { ...input, originalName: 'second.png' });

      expect(inserted).not.toBeNull();
      expect(deduped).toEqual(inserted);
    } finally {
      store.close();
    }
  });
});
