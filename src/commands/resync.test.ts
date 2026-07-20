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

  it('returns only the requested project when scoped', () => {
    const mine = createTicketFlow(store, { key: 'A', title: 'a', projectId: 1 }).id;
    createTicketFlow(store, { key: 'B', title: 'b', projectId: 2 });

    const snap = resync(store, () => true, { projectId: 1 });
    expect(snap.tickets.map((t) => t.id)).toEqual([mine]);
  });

  it('still reconciles across every project even when scoped', () => {
    // Reconcile is global on purpose: a dead server belonging to another project
    // must still be pruned, or it lingers until that window happens to open.
    const theirs = createTicketFlow(store, { key: 'B', title: 'b', projectId: 2 }).id;
    store.db
      .prepare(
        "INSERT INTO servers (ticket_id, service, status, pid, log_path) VALUES (?, 'be', 'running', 7, '/l')",
      )
      .run(theirs);

    const snap = resync(store, () => false, { projectId: 1 });
    expect(snap.tickets).toEqual([]); // not our project's ticket
    expect(snap.deadServers).toHaveLength(1); // but its dead server is still swept
  });
});
