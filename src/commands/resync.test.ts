import { describe, it, expect, beforeEach } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { createTicketFlow } from '../workflow/stages/create.js';
import { transition } from '../workflow/machine.js';
import { resync } from './resync.js';

describe('resync', () => {
  let store: Store;
  beforeEach(() => {
    store = openStore(':memory:');
  });

  it('rebuilds a registry snapshot: every ticket with its derived stage', () => {
    const a = createTicketFlow(store, { key: 'A', title: 'a' }).id;
    const b = createTicketFlow(store, { key: 'B', title: 'b' }).id;
    transition(store, a, 'scope', { kind: 'passed' }); // impl

    const snap = resync(store, () => true);
    expect(snap.tickets).toHaveLength(2);
    expect(snap.tickets.find((t) => t.id === a)!.stageCurrent).toBe('impl');
    expect(snap.tickets.find((t) => t.id === b)!.stageCurrent).toBe('scope');
  });

  it('reconciles dead servers as part of the resync', () => {
    const id = createTicketFlow(store, { key: 'A', title: 'a' }).id;
    store.db
      .prepare(
        "INSERT INTO servers (ticket_id, service, status, pid, log_path) VALUES (?, 'be', 'running', 7, '/l')",
      )
      .run(id);

    const snap = resync(store, () => false); // all dead
    expect(snap.deadServers).toHaveLength(1);
    const row = store.db.prepare('SELECT status FROM servers WHERE pid = 7').get() as
      | { status: string }
      | undefined;
    expect(row).toBeUndefined(); // dead row pruned, not left as stale 'stopped'
  });
});
