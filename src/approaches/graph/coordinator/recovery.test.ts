/**
 * Graph recovery tests (Slice 3 Task 9, recovery row).
 *
 * Recovery is graph-aware: the coordinator atomically claims a BLOCKED graph
 * run, resolves the failure category from its persisted reason, and moves
 * every blocked node run to `launching` — a LAUNCH RETRY that reuses the
 * reserved visit (the token stays claimed: there is no claimed → pending
 * transition) and does NOT re-snapshot the prompt. Only after the retry has
 * durably entered that recoverable state is the visible stage block cleared.
 * It never synthesizes node success, chooses a fallback provider, or advances
 * the stage. `termination-unknown` is never auto-retried (the user must
 * discard the unknown process).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../../../store/db.js';
import { createTicket } from '../../../store/tickets.js';
import { setStage } from '../../../store/stages.js';
import { stageBlock } from '../../../store/stageBlocks.js';
import { recoverGraphRun, type RecoveryDeps } from './recovery.js';

describe('recoverGraphRun', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  interface Fixture {
    ticketId: number;
    graphRunId: number;
  }

  function blockedGraph(
    reason: string,
    nodeStatuses: { id: number; status: string }[],
  ): Fixture {
    const ticketId = createTicket(store, { key: 'RC-1', title: 'thing' }).id;
    store.db.prepare("UPDATE tickets SET stage_current = 'impl' WHERE id = ?").run(ticketId);
    store.db
      .prepare("UPDATE stages SET status = 'running' WHERE ticket_id = ? AND stage_key = 'impl'")
      .run(ticketId);
    const graphRunId = Number(
      store.db
        .prepare(
          `INSERT INTO approach_graph_runs (ticket_id, stage_key, stage_attempt, approach_id, status, blocked_reason, created_at)
           VALUES (?, 'impl', 0, 'x', 'blocked', ?, '2026-08-12T00:00:00.000Z')`,
        )
        .run(ticketId, reason)
        .lastInsertRowid,
    );
    const revisionId = Number(
      store.db
        .prepare(
          `INSERT INTO approach_graph_revisions
             (graph_run_id, revision_number, canonical_graph, fingerprint, status, created_at)
           VALUES (?, 1, '{}', 'fp', 'active', '2026-08-12T00:00:00.000Z')`,
        )
        .run(graphRunId)
        .lastInsertRowid,
    );
    for (const node of nodeStatuses) {
      store.db
        .prepare(
          `INSERT INTO approach_node_runs
             (id, graph_run_id, revision_id, node_id, node_kind, visit_number, status)
           VALUES (?, ?, ?, 'n', 'agent', ?, ?)`,
        )
        .run(node.id, graphRunId, revisionId, node.id, node.status);
    }
    // Park the impl stage block the recovery will clear.
    setStage(store, ticketId, 'impl', {
      status: 'running',
      blockedKind: 'approach-graph-failed',
      blockedReason: `approach-graph-failed: ${reason} (graph run ${graphRunId})`,
      blockedAt: '2026-08-12T00:00:00.000Z',
    });
    return { ticketId, graphRunId };
  }

  function makeDeps(overrides: Partial<RecoveryDeps> = {}): RecoveryDeps {
    return {
      store,
      transaction: <T>(fn: () => T): T =>
        (store.db.transaction as unknown as (f: () => T, o: { begin: 'immediate' }) => () => T)(fn, {
          begin: 'immediate',
        })(),
      now: () => '2026-08-12T00:00:00.000Z',
      debug: () => {},
      ...overrides,
    };
  }

  it('retries blocked node runs and clears the block only after the retry entered', () => {
    const { ticketId, graphRunId } = blockedGraph('node-blocked: node 5 (agent said blocked)', [
      { id: 5, status: 'blocked' },
      { id: 6, status: 'completed' },
    ]);
    const result = recoverGraphRun(makeDeps(), { ticketId, graphRunId });
    expect(result).toEqual({ kind: 'retried', retried: [5] });
    const run = store.db
      .prepare('SELECT status, blocked_reason FROM approach_graph_runs WHERE id = ?')
      .get(graphRunId) as { status: string; blocked_reason: string | null };
    expect(run.status).toBe('running');
    expect(run.blocked_reason).toBeNull();
    // The failing node is back at `launching` — a retry, never a completed.
    const node = store.db
      .prepare('SELECT status FROM approach_node_runs WHERE id = ?')
      .get(5) as { status: string };
    expect(node.status).toBe('launching');
    // The visible stage block is gone: recovery durably entered.
    expect(stageBlock(store, ticketId, 'impl')).toBeNull();
  });

  it('resource-claim-violated retries via the launch path (V1: same revision)', () => {
    const { ticketId, graphRunId } = blockedGraph('resource-claim-violated: b.ts', [{ id: 7, status: 'blocked' }]);
    const result = recoverGraphRun(makeDeps(), { ticketId, graphRunId });
    expect(result.kind).toBe('retried');
    const node = store.db
      .prepare('SELECT status FROM approach_node_runs WHERE id = ?')
      .get(7) as { status: string };
    expect(node.status).toBe('launching');
  });

  it('termination-unknown is never auto-retried', () => {
    const { ticketId, graphRunId } = blockedGraph('node-blocked: node 8 (termination-unknown)', [
      { id: 8, status: 'termination-unknown' },
    ]);
    const result = recoverGraphRun(makeDeps(), { ticketId, graphRunId });
    expect(result.kind).toBe('refused');
    const run = store.db
      .prepare('SELECT status FROM approach_graph_runs WHERE id = ?')
      .get(graphRunId) as { status: string };
    expect(run.status).toBe('blocked');
    expect(stageBlock(store, ticketId, 'impl')).not.toBeNull();
  });

  it('a run that is not blocked is not claimed (idempotent no-op)', () => {
    const { ticketId, graphRunId } = blockedGraph('node-blocked: x', [{ id: 9, status: 'blocked' }]);
    store.db.prepare('UPDATE approach_graph_runs SET status = ? WHERE id = ?').run('running', graphRunId);
    const result = recoverGraphRun(makeDeps(), { ticketId, graphRunId });
    expect(result.kind).toBe('no-op');
  });

  it('never advances the stage or synthesizes a success', () => {
    const { ticketId, graphRunId } = blockedGraph('node-blocked: x', [{ id: 10, status: 'blocked' }]);
    recoverGraphRun(makeDeps(), { ticketId, graphRunId });
    const ticket = store.db
      .prepare('SELECT stage_current FROM tickets WHERE id = ?')
      .get(ticketId) as { stage_current: string };
    expect(ticket.stage_current).toBe('impl');
    const node = store.db
      .prepare('SELECT status, outcome FROM approach_node_runs WHERE id = ?')
      .get(10) as { status: string; outcome: string | null };
    expect(node.status).not.toBe('completed');
    expect(node.outcome).toBeNull();
  });
});
