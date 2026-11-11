import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { createTicket } from '../../store/tickets.js';
import { stageAttempt } from '../../store/stages.js';
import { advanceConsumedGraphAttempt } from './graphLaunchOps.js';

describe('advanceConsumedGraphAttempt', () => {
  let store: Store;
  let ticketId: number;

  beforeEach(() => {
    store = openStore(':memory:');
    ticketId = createTicket(store, { key: 'T-OPS', title: 'test' }).id;
  });

  afterEach(() => {
    store.close();
  });

  it('returns false and mutates nothing when decision status is not a terminal status', () => {
    const lines: string[] = [];
    const log = (m: string): void => void lines.push(m);
    const advanced = advanceConsumedGraphAttempt(
      store,
      ticketId,
      { kind: 'attempt-consumed', graphRunId: 1, status: 'running', stageAttempt: 0 },
      0,
      log,
    );
    expect(advanced).toBe(false);
    expect(stageAttempt(store, ticketId, 'impl')).toBe(0);
    expect(lines).toHaveLength(0);
  });

  it('advances attempt when status is closed', () => {
    const lines: string[] = [];
    const log = (m: string): void => void lines.push(m);
    const advanced = advanceConsumedGraphAttempt(
      store,
      ticketId,
      { kind: 'attempt-consumed', graphRunId: 1, status: 'closed', stageAttempt: 0 },
      0,
      log,
    );
    expect(advanced).toBe(true);
    expect(stageAttempt(store, ticketId, 'impl')).toBe(1);
    expect(lines[0]).toContain(`advanced ticket T${ticketId} impl attempt to 1 following terminal (closed) graph run 1`);
  });

  it('advances attempt when status is cancelled', () => {
    const lines: string[] = [];
    const log = (m: string): void => void lines.push(m);
    store.db.prepare(
      `INSERT INTO approach_graph_runs (ticket_id, stage_key, stage_attempt, approach_id, status, created_at)
       VALUES (?, 'impl', 2, 'g', 'cancelled', '2026-08-01T00:00:00.000Z')`,
    ).run(ticketId);

    const advanced = advanceConsumedGraphAttempt(
      store,
      ticketId,
      { kind: 'attempt-consumed', graphRunId: 1, status: 'cancelled', stageAttempt: 0 },
      0,
      log,
    );
    expect(advanced).toBe(true);
    expect(stageAttempt(store, ticketId, 'impl')).toBe(3);
    expect(lines[0]).toContain(`advanced ticket T${ticketId} impl attempt to 3`);
  });

  it('advances attempt when status is stale', () => {
    const advanced = advanceConsumedGraphAttempt(
      store,
      ticketId,
      { kind: 'attempt-consumed', graphRunId: 1, status: 'stale', stageAttempt: 1 },
      1,
    );
    expect(advanced).toBe(true);
    expect(stageAttempt(store, ticketId, 'impl')).toBe(2);
  });
});
