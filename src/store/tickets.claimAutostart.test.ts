import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openStore, type Store } from './db.js';
import { claimAutostart, createTicket, findTicketById } from './tickets.js';

describe('claimAutostart', () => {
  const opened: Store[] = [];
  const dirs: string[] = [];
  afterEach(() => {
    for (const s of opened.splice(0)) s.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('claims a queued ticket once and clears the flag', () => {
    const store = openStore(':memory:');
    opened.push(store);
    const t = createTicket(store, { key: 'A-1', title: 't', autostartPending: true });
    expect(claimAutostart(store, t.id)).toBe(true);
    expect(findTicketById(store, t.id)?.autostartPending).toBe(false);
    expect(claimAutostart(store, t.id)).toBe(false);
  });

  it('refuses an unqueued or missing ticket', () => {
    const store = openStore(':memory:');
    opened.push(store);
    const t = createTicket(store, { key: 'A-1', title: 't' });
    expect(claimAutostart(store, t.id)).toBe(false);
    expect(claimAutostart(store, 9999)).toBe(false);
  });

  it('two connections on one DB file: exactly one claim wins', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-claim-'));
    dirs.push(dir);
    const file = join(dir, 'k.db');
    const a = openStore(file);
    opened.push(a);
    const b = openStore(file);
    opened.push(b);
    const t = createTicket(a, { key: 'A-1', title: 't', autostartPending: true });
    const results = [claimAutostart(a, t.id), claimAutostart(b, t.id)];
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(findTicketById(b, t.id)?.autostartPending).toBe(false);
  });
});
