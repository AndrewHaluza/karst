/**
 * Graph marker-guard tests (Slice 3 Task 9).
 *
 * The guarded IMPL marker is the ONLY way a graph ticket's impl passes: in
 * the same transaction as the machine's transition it re-checks the graph
 * run is marker-ready AND quiescent, then closes it. An earlier marker is
 * rejected WITHOUT mutation; the flip and the stage advance commit together.
 * The stage-block write goes through stageBlocks infrastructure and is
 * refused once the ticket leaves impl.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { createTicket } from '../store/tickets.js';
import { stageAttempt } from '../store/stages.js';
import { stageBlock } from '../store/stageBlocks.js';
import {
  graphImplMarkerGuard,
  blockGraphStage,
  GRAPH_FAILED_BLOCKER,
} from './graphMarkerGuard.js';

describe('graphImplMarkerGuard', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  /** A ticket whose impl graph run is marker-ready, fully quiescent. */
  function markerReadyTicket(key: string): { ticketId: number; graphRunId: number; attempt: number } {
    const ticketId = createTicket(store, { key, title: 'thing' }).id;
    store.db.prepare("UPDATE tickets SET stage_current = 'impl' WHERE id = ?").run(ticketId);
    store.db
      .prepare(`UPDATE stages SET status = 'running' WHERE ticket_id = ? AND stage_key = 'impl'`)
      .run(ticketId);
    const attempt = stageAttempt(store, ticketId, 'impl');
    const graphRunId = Number(
      store.db
        .prepare(
          `INSERT INTO approach_graph_runs (ticket_id, stage_key, stage_attempt, approach_id, status, created_at)
           VALUES (?, 'impl', ?, 'x', 'completed-awaiting-impl-marker', '2026-08-12T00:00:00.000Z')`,
        )
        .run(ticketId, attempt)
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
    // An END token makes the run quiescent (no pending/claimed non-END, no
    // active node runs, no ambiguous leases).
    store.db
      .prepare(
        `INSERT INTO approach_graph_tokens
           (revision_id, source_node_run_id, is_entry, edge_id, destination_node_id,
            destination_end, fork_instance, fork_lineage, status, created_at)
         VALUES (?, NULL, 1, 'e1', 'END', 1, 0, 'root', 'consumed', '2026-08-12T00:00:00.000Z')`,
      )
      .run(revisionId);
    return { ticketId, graphRunId, attempt };
  }

  it('passes the marker once: the run closes and the ticket advances to uat', () => {
    const { ticketId, graphRunId, attempt } = markerReadyTicket('GM-1');
    const result = graphImplMarkerGuard(store, ticketId);
    expect(result).toEqual({ ok: true, graphRunId });
    const run = store.db
      .prepare('SELECT status FROM approach_graph_runs WHERE id = ?')
      .get(graphRunId) as { status: string };
    expect(run.status).toBe('closed');
    const ticket = store.db
      .prepare('SELECT stage_current FROM tickets WHERE id = ?')
      .get(ticketId) as { stage_current: string };
    expect(ticket.stage_current).toBe('uat');
  });

  it('a second marker is rejected without mutation (closed exactly once)', () => {
    const { ticketId, graphRunId, attempt } = markerReadyTicket('GM-2');
    expect(graphImplMarkerGuard(store, ticketId).ok).toBe(true);
    const before = store.db
      .prepare('SELECT stage_current FROM tickets WHERE id = ?')
      .get(ticketId) as { stage_current: string };
    const result = graphImplMarkerGuard(store, ticketId);
    expect(result.ok).toBe(false);
    expect(store.db.prepare('SELECT stage_current FROM tickets WHERE id = ?').get(ticketId)).toEqual(before);
    expect(
      (store.db.prepare('SELECT status FROM approach_graph_runs WHERE id = ?').get(graphRunId) as { status: string })
        .status,
    ).toBe('closed');
  });

  it('an earlier marker is rejected WITHOUT mutation (run still running)', () => {
    const { ticketId, graphRunId, attempt } = markerReadyTicket('GM-3');
    // The run is still RUNNING: the marker must not close it nor advance the
    // ticket. (One run per (ticket, attempt) by schema, so rewind the ready
    // run rather than insert a second.)
    store.db
      .prepare('UPDATE approach_graph_runs SET status = ? WHERE id = ?')
      .run('running', graphRunId);
    const result = graphImplMarkerGuard(store, ticketId);
    expect(result.ok).toBe(false);
    expect(
      (store.db.prepare('SELECT stage_current FROM tickets WHERE id = ?').get(ticketId) as { stage_current: string })
        .stage_current,
    ).toBe('impl');
  });

  it('a marker with a non-quiescent run is rejected (pending work sneaks in)', () => {
    const { ticketId, graphRunId, attempt } = markerReadyTicket('GM-4');
    // A claimed non-END token lands between the flip and the marker.
    const revisionId = (
      store.db
        .prepare('SELECT id FROM approach_graph_revisions WHERE graph_run_id = ?')
        .get(graphRunId) as { id: number }
    ).id;
    store.db
      .prepare(
        `INSERT INTO approach_graph_tokens
           (revision_id, source_node_run_id, is_entry, edge_id, destination_node_id,
            destination_end, fork_instance, fork_lineage, status, created_at)
         VALUES (?, NULL, 1, 'e2', 'b', 0, 0, 'root', 'claimed', '2026-08-12T00:00:00.000Z')`,
      )
      .run(revisionId);
    const result = graphImplMarkerGuard(store, ticketId);
    expect(result.ok).toBe(false);
    expect(
      (store.db.prepare('SELECT stage_current FROM tickets WHERE id = ?').get(ticketId) as { stage_current: string })
        .stage_current,
    ).toBe('impl');
  });

  it('a run of an older stage attempt can never be closed by a later marker', () => {
    const { ticketId, graphRunId } = markerReadyTicket('GM-5');
    // The ticket re-attempted impl (a failed impl → fix loop bumped the
    // attempt); the marker derives the CURRENT attempt and finds no run for
    // it — the stale run stays open and the ticket stays at impl.
    store.db
      .prepare("UPDATE stages SET attempt = 1 WHERE ticket_id = ? AND stage_key = 'impl'")
      .run(ticketId);
    const result = graphImplMarkerGuard(store, ticketId);
    expect(result.ok).toBe(false);
    expect(
      (store.db.prepare('SELECT status FROM approach_graph_runs WHERE id = ?').get(graphRunId) as { status: string })
        .status,
    ).toBe('completed-awaiting-impl-marker');
  });
});

describe('blockGraphStage', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  it('writes the approach-graph-failed block through the stageBlocks infrastructure', () => {
    const ticketId = createTicket(store, { key: 'BG-1', title: 'thing' }).id;
    store.db.prepare("UPDATE tickets SET stage_current = 'impl' WHERE id = ?").run(ticketId);
    const graphRunId = Number(
      store.db
        .prepare(
          `INSERT INTO approach_graph_runs (ticket_id, stage_key, stage_attempt, approach_id, status, blocked_reason, created_at)
           VALUES (?, 'impl', 0, 'x', 'blocked', 'resource-claim-violated: b.ts', '2026-08-12T00:00:00.000Z')`,
        )
        .run(ticketId)
        .lastInsertRowid,
    );
    blockGraphStage(store, ticketId, graphRunId, () => '2026-08-12T00:00:00.000Z');
    const block = stageBlock(store, ticketId, 'impl');
    expect(block?.kind).toBe(GRAPH_FAILED_BLOCKER);
    expect(block?.reason).toContain('resource-claim-violated: b.ts');
  });

  it('refuses once the ticket left impl (stage-scoped write path)', () => {
    const ticketId = createTicket(store, { key: 'BG-2', title: 'thing' }).id;
    store.db.prepare("UPDATE tickets SET stage_current = 'uat' WHERE id = ?").run(ticketId);
    const graphRunId = Number(
      store.db
        .prepare(
          `INSERT INTO approach_graph_runs (ticket_id, stage_key, stage_attempt, approach_id, status, blocked_reason, created_at)
           VALUES (?, 'impl', 0, 'x', 'blocked', 'integration-conflict: x', '2026-08-12T00:00:00.000Z')`,
        )
        .run(ticketId)
        .lastInsertRowid,
    );
    blockGraphStage(store, ticketId, graphRunId, () => '2026-08-12T00:00:00.000Z');
    expect(stageBlock(store, ticketId, 'impl')).toBeNull();
  });
});
