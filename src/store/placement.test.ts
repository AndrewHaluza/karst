import { describe, it, expect } from 'vitest';
import { openStore } from './db.js';
import { createTicket, getTicket } from './tickets.js';
import { backfillPlacement, getPlacement, recordPlacement, clearPlacement, placementLine, type TicketPlacement } from './placement.js';

function fresh() {
  const store = openStore(':memory:');
  const id = createTicket(store, { key: 'K-1', title: 't' }).id;
  return { store, id };
}

describe('ticket placement', () => {
  it('is unrecorded (null) on a new ticket', () => {
    const { store, id } = fresh();
    expect(getPlacement(store, id)).toBeNull();
  });

  it('round-trips a sandbox placement and writes sessionProvider in the same call', () => {
    const { store, id } = fresh();
    const p: TicketPlacement = { backend: 'sbx', core: 'claude', sandboxName: 'karst-ab-1-claude', reason: null };
    recordPlacement(store, id, p, 'claude');
    expect(getPlacement(store, id)).toEqual(p);
    expect(getTicket(store, id).sessionProvider).toBe('claude');
  });

  it('records a host fallback with its reason and keeps the core', () => {
    const { store, id } = fresh();
    recordPlacement(store, id, { backend: 'host', core: 'claude', sandboxName: null, reason: 'sbx: not signed in' }, 'claude');
    expect(getPlacement(store, id)).toEqual({ backend: 'host', core: 'claude', sandboxName: null, reason: 'sbx: not signed in' });
  });

  it('overwrites the previous placement (core switch) and can clear it', () => {
    const { store, id } = fresh();
    recordPlacement(store, id, { backend: 'sbx', core: 'claude', sandboxName: 'a', reason: null }, 'claude');
    recordPlacement(store, id, { backend: 'docker', core: 'opencode', sandboxName: 'b', reason: null }, 'opencode');
    expect(getPlacement(store, id)?.backend).toBe('docker');
    clearPlacement(store, id);
    expect(getPlacement(store, id)).toBeNull();
  });

  it('ignores a garbage backend value as unrecorded', () => {
    const { store, id } = fresh();
    store.db.prepare("UPDATE tickets SET placement_backend = 'weird' WHERE id = ?").run(id);
    expect(getPlacement(store, id)).toBeNull();
  });

  it('states placement as one line for context and instructions', () => {
    expect(placementLine({ backend: 'host', core: 'claude', sandboxName: null, reason: null })).toBe('Runs on: host');
    expect(placementLine({ backend: 'host', core: 'claude', sandboxName: null, reason: 'sbx: x' })).toBe('Runs on: host (sbx: x)');
    expect(placementLine({ backend: 'sbx', core: 'claude', sandboxName: 'n1', reason: null })).toBe('Runs in: sbx sandbox n1 — commit only, no push, host syncs');
    expect(placementLine({ backend: 'docker', core: 'opencode', sandboxName: 'c1', reason: null })).toBe('Runs in: docker sandbox c1 — commit only, no push, host syncs');
    expect(placementLine(null)).toBeNull();
  });
});

describe('backfillPlacement (D245 one-time migration)', () => {
  it('a listed sandbox sets backend+core+name; an unlisted ticket becomes host; recorded rows are untouched', () => {
    const { store, id } = fresh();
    const b = createTicket(store, { key: 'K-2', title: 'b' }).id;
    const c = createTicket(store, { key: 'K-3', title: 'c' }).id;
    recordPlacement(store, c, { backend: 'docker', core: 'opencode2', sandboxName: 'keep', reason: null }, null);
    const n = backfillPlacement(store, [{ ticketId: id, runner: 'sbx', core: 'claude', name: 'karst-1' }, { ticketId: c, runner: 'sbx', core: 'claude', name: 'x' }]);
    expect(n).toBe(2);
    expect(getPlacement(store, id)).toEqual({ backend: 'sbx', core: 'claude', sandboxName: 'karst-1', reason: null });
    expect(getPlacement(store, b)).toEqual({ backend: 'host', core: null, sandboxName: null, reason: 'backfill: no sandbox' });
    expect(getPlacement(store, c)?.sandboxName).toBe('keep');
    expect(backfillPlacement(store, [])).toBe(0);
  });
  it('keeps the session provider as the host core', () => {
    const { store, id } = fresh();
    store.db.prepare("UPDATE tickets SET session_provider = 'claude' WHERE id = ?").run(id);
    backfillPlacement(store, []);
    expect(getPlacement(store, id)?.core).toBe('claude');
  });
});

it('backfillPlacement with a projectId leaves other projects unrecorded', () => {
  const { store, id } = fresh();
  store.db.prepare('UPDATE tickets SET project_id = 5 WHERE id = ?').run(id);
  expect(backfillPlacement(store, [], 6)).toBe(0);
  expect(getPlacement(store, id)).toBeNull();
  expect(backfillPlacement(store, [], 5)).toBe(1);
});
