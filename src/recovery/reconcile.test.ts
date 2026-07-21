import { describe, it, expect, beforeEach } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { createTicketFlow } from '../workflow/stages/create.js';
import { getTicket } from '../store/tickets.js';
import { setStage } from '../store/stages.js';
import { transition } from '../workflow/machine.js';
import { reconcileOnStart, deriveStageCurrent } from './reconcile.js';

function seedServer(
  store: Store,
  ticketId: number,
  pid: number,
  status: 'running' | 'stopped',
): number {
  const info = store.db
    .prepare(
      "INSERT INTO servers (ticket_id, repo, host, port, pid, status, log_path) VALUES (?, 'backend', 'localhost', 8000, ?, ?, '/l')",
    )
    .run(ticketId, pid, status);
  return Number(info.lastInsertRowid);
}

describe('deriveStageCurrent', () => {
  it('is the running stage when one is running', () => {
    const store = openStore(':memory:');
    const id = createTicketFlow(store, { key: 'T', title: 't' }).id;
    transition(store, id, 'scope', { kind: 'passed' }); // impl running
    expect(deriveStageCurrent(getTicket(store, id).stages)).toBe('impl');
  });

  it('is the last passed stage when none is running', () => {
    const store = openStore(':memory:');
    const id = createTicketFlow(store, { key: 'T', title: 't' }).id;
    setStage(store, id, 'scope', { status: 'passed' });
    setStage(store, id, 'impl', { status: 'passed' });
    // nothing running -> furthest progress is impl
    expect(deriveStageCurrent(getTicket(store, id).stages)).toBe('impl');
  });

  it('defaults to scope for a fresh ticket (all pending)', () => {
    const store = openStore(':memory:');
    const id = createTicketFlow(store, { key: 'T', title: 't' }).id;
    expect(deriveStageCurrent(getTicket(store, id).stages)).toBe('scope');
  });

  it('picks review over the earlier-passed fix across the loop back-edge (by recency, not key order)', () => {
    // fix comes AFTER review in STAGE_KEYS, but the graph loops fix->review.
    // After fix passes and review re-runs to a terminal verdict, the *current*
    // stage is review — not fix — even though fix has a higher array index.
    const store = openStore(':memory:');
    const id = createTicketFlow(store, { key: 'T', title: 't' }).id;
    setStage(store, id, 'scope', { status: 'passed', endedAt: '2026-01-01T00:00:00.000Z' });
    setStage(store, id, 'impl', { status: 'passed', endedAt: '2026-01-01T00:01:00.000Z' });
    setStage(store, id, 'uat', { status: 'passed', endedAt: '2026-01-01T00:02:00.000Z' });
    // first review fail -> fix pass -> review passes again (later timestamp)
    setStage(store, id, 'fix', { status: 'passed', endedAt: '2026-01-01T00:03:00.000Z' });
    setStage(store, id, 'review', { status: 'passed', endedAt: '2026-01-01T00:04:00.000Z' });
    expect(deriveStageCurrent(getTicket(store, id).stages)).toBe('review');
  });
});

describe('reconcileOnStart', () => {
  let store: Store;
  beforeEach(() => {
    store = openStore(':memory:');
  });

  // Tickets shipped by an earlier build carry a `done` row stuck at 'running' —
  // it could never complete, since nothing runs at a terminal stage. Those rows
  // outlive the fix, so boot has to close them or the ticket stays blue forever.
  it('closes a terminal stage an older build left running', () => {
    const id = createTicketFlow(store, { key: 'T', title: 't' }).id;
    setStage(store, id, 'ship', { status: 'passed', endedAt: '2026-07-16T10:00:00Z' });
    setStage(store, id, 'done', { status: 'running', startedAt: '2026-07-16T10:00:01Z' });

    reconcileOnStart(store, () => false);

    const done = getTicket(store, id).stages.find((s) => s.stageKey === 'done')!;
    expect(done.status).toBe('passed');
    // It ended when it was entered — boot must not backdate it to now.
    expect(done.endedAt).toBe('2026-07-16T10:00:01Z');
    expect(getTicket(store, id).stageCurrent).toBe('done');
  });

  it('leaves a running non-terminal stage alone (it is genuinely re-runnable)', () => {
    const id = createTicketFlow(store, { key: 'T', title: 't' }).id;
    transition(store, id, 'review', { kind: 'passed' }); // ship running

    reconcileOnStart(store, () => false);

    expect(getTicket(store, id).stages.find((s) => s.stageKey === 'ship')!.status).toBe('running');
  });

  it('restores stage_current from the stages table for every ticket', () => {
    const id = createTicketFlow(store, { key: 'T', title: 't' }).id;
    transition(store, id, 'scope', { kind: 'passed' }); // impl
    transition(store, id, 'impl', { kind: 'passed' }); // uat running
    // corrupt the cached stage_current, as if it drifted on a crash
    store.db.prepare('UPDATE tickets SET stage_current = ? WHERE id = ?').run('scope', id);

    reconcileOnStart(store, () => true);
    expect(getTicket(store, id).stageCurrent).toBe('uat');
  });

  it('marks running-but-dead servers offline (retained) and offers them for restart', () => {
    const id = createTicketFlow(store, { key: 'T', title: 't' }).id;
    const deadId = seedServer(store, id, 4242, 'running');
    const liveId = seedServer(store, id, 4243, 'running');

    const isAlive = (pid: number) => pid === 4243; // 4242 is dead
    const result = reconcileOnStart(store, isAlive);

    const rows = store.db.prepare('SELECT id, status, pid FROM servers ORDER BY id').all() as {
      id: number;
      status: string;
      pid: number | null;
    }[];
    // Dead server retained as offline (not pruned) so it surfaces for restart.
    const dead = rows.find((r) => r.id === deadId)!;
    expect(dead.status).toBe('stopped');
    expect(dead.pid).toBeNull();
    expect(rows.find((r) => r.id === liveId)!.status).toBe('running');
    expect(result.deadServers.map((s) => s.id)).toEqual([deadId]);
  });

  it('leaves already-stopped servers untouched', () => {
    const id = createTicketFlow(store, { key: 'T', title: 't' }).id;
    const stoppedId = seedServer(store, id, 9, 'stopped');
    const result = reconcileOnStart(store, () => false);
    expect(result.deadServers.find((s) => s.id === stoppedId)).toBeUndefined();
  });
});
