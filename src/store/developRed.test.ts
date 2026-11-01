import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from './db.js';
import { createTicket } from './tickets.js';
import { parseDevelopRedAlert, raiseDevelopRedAlert } from './developRed.js';

const SHA = 'a'.repeat(40);
const OUT = `x\nNOTICE: develop is red: a\nKARST-ALERT: develop-red base=${SHA} tests=src/a.test.ts > t1; src/b.test.ts > t2\n`;

describe('develop-red alert', () => {
  let store: Store;
  let t1: number;
  let t2: number;
  beforeEach(() => {
    store = openStore(':memory:');
    t1 = createTicket(store, { key: 'K1', title: 'one' }).id;
    t2 = createTicket(store, { key: 'K2', title: 'two' }).id;
  });
  afterEach(() => store.close());

  it('parses the alert line', () => {
    expect(parseDevelopRedAlert(OUT)).toEqual({ sha: SHA, tests: ['src/a.test.ts > t1', 'src/b.test.ts > t2'] });
    expect(parseDevelopRedAlert('all green')).toBeNull();
  });

  it('a drift run raises one shared alert, deduped per base sha across tickets', () => {
    expect(raiseDevelopRedAlert(store, t1, OUT)).toBe(true);
    expect(raiseDevelopRedAlert(store, t2, OUT)).toBe(false);
    expect(raiseDevelopRedAlert(store, t1, OUT)).toBe(false);
    const notes = store.db.prepare(`SELECT title, body, merge_sha FROM bulletin_notes`).all() as Array<{ title: string; body: string; merge_sha: string }>;
    expect(notes).toHaveLength(1);
    expect(notes[0]!.title).toContain('develop is red');
    expect(notes[0]!.body).toContain('src/b.test.ts > t2');
    expect(notes[0]!.merge_sha).toBe(SHA);
  });

  it('raises nothing without an alert line', () => {
    expect(raiseDevelopRedAlert(store, t1, 'ok')).toBe(false);
  });
});
