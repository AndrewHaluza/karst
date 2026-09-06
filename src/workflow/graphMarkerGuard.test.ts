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
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openStore, type Store } from '../store/db.js';
import { createTicket } from '../store/tickets.js';
import { stageAttempt } from '../store/stages.js';
import { stageBlock } from '../store/stageBlocks.js';
import {
  graphImplMarkerGuard,
  fireGraphImplMarkerFromHost,
  blockGraphStage,
  graphApproachMissingRun,
  GRAPH_FAILED_BLOCKER,
} from './graphMarkerGuard.js';
import { BUILT_IN_PACKAGE_ID } from '../approaches/builtIn.js';
import { workspacesForNode } from '../store/graph/nodeRuns.js';
import { nodeWorkspaceDir } from '../approaches/graph/workspace/provider.js';

describe('graphImplMarkerGuard', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  /** A ticket whose impl graph run is marker-ready, fully quiescent. */
  function markerReadyTicket(key: string): { ticketId: number; graphRunId: number; attempt: number } {
    store.db.prepare("INSERT OR IGNORE INTO projects (slug) VALUES ('proj')").run();
    const projectId = (
      store.db.prepare("SELECT id FROM projects WHERE slug = 'proj'").get() as { id: number }
    ).id;
    const ticketId = createTicket(store, { key, title: 'thing', projectId }).id;
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

  it('cleans terminal node workspaces when the graph run closes', () => {
    const { ticketId, graphRunId } = markerReadyTicket('GM-CLEAN');
    const revisionId = (
      store.db
        .prepare('SELECT id FROM approach_graph_revisions WHERE graph_run_id = ?')
        .get(graphRunId) as { id: number }
    ).id;
    const globalRoot = mkdtempSync(join(tmpdir(), 'karst-run-close-'));
    const workspaceRoot = nodeWorkspaceDir(globalRoot, 'proj', ticketId, graphRunId, 100);
    const cancelledWorkspaceRoot = nodeWorkspaceDir(globalRoot, 'proj', ticketId, graphRunId, 101);
    try {
      const workspaceCwd = join(workspaceRoot, 'api');
      const cancelledWorkspaceCwd = join(cancelledWorkspaceRoot, 'web');
      mkdirSync(workspaceCwd, { recursive: true });
      mkdirSync(cancelledWorkspaceCwd, { recursive: true });
      writeFileSync(join(workspaceCwd, 'scratch.txt'), 'closed run workspace\n');
      writeFileSync(join(cancelledWorkspaceCwd, 'scratch.txt'), 'cancelled node workspace\n');
      store.db
        .prepare(
          `INSERT INTO approach_node_runs
             (id, graph_run_id, revision_id, node_id, node_kind, visit_number, status)
           VALUES (100, ?, ?, 'done-node', 'agent', 1, 'completed')`,
        )
        .run(graphRunId, revisionId);
      store.db
        .prepare(
          `INSERT INTO approach_node_runs
             (id, graph_run_id, revision_id, node_id, node_kind, visit_number, status)
           VALUES (101, ?, ?, 'cancelled-node', 'agent', 1, 'cancelled')`,
        )
        .run(graphRunId, revisionId);
      store.db
        .prepare(
          `INSERT INTO approach_graph_workspaces
             (graph_run_id, node_run_id, repo_name, cwd, byte_size, created_at)
           VALUES (?, 100, 'api', ?, 128, '2026-08-12T00:00:00.000Z')`,
        )
        .run(graphRunId, workspaceCwd);
      store.db
        .prepare(
          `INSERT INTO approach_graph_workspaces
             (graph_run_id, node_run_id, repo_name, cwd, byte_size, created_at)
           VALUES (?, 101, 'web', ?, 32, '2026-08-12T00:00:00.000Z')`,
        )
        .run(graphRunId, cancelledWorkspaceCwd);
      store.db
        .prepare('UPDATE approach_graph_runs SET workspace_bytes = 160 WHERE id = ?')
        .run(graphRunId);
      const serverId = Number(
        store.db
          .prepare(
            `INSERT INTO servers (ticket_id, repo, pid, status, cwd, started_at)
             VALUES (?, 'api', NULL, 'running', ?, '2026-08-12T00:00:00.000Z')`,
          )
          .run(ticketId, workspaceCwd)
          .lastInsertRowid,
      );

      const result = graphImplMarkerGuard(store, ticketId);

      expect(result).toEqual({ ok: true, graphRunId });
      expect(existsSync(workspaceRoot)).toBe(false);
      expect(existsSync(cancelledWorkspaceRoot)).toBe(false);
      expect(workspacesForNode(store.db, 100)).toEqual([]);
      expect(workspacesForNode(store.db, 101)).toEqual([]);
      expect(
        store.db.prepare('SELECT workspace_bytes FROM approach_graph_runs WHERE id = ?').get(graphRunId),
      ).toEqual({ workspace_bytes: 0 });
      expect(store.db.prepare('SELECT status FROM servers WHERE id = ?').get(serverId)).toEqual({
        status: 'stopped',
      });
    } finally {
      rmSync(globalRoot, { recursive: true, force: true });
    }
  });

  it('says a cancelled run is terminal and will never become marker-ready', () => {
    const { ticketId } = markerReadyTicket('GM-TERM');
    store.db
      .prepare("UPDATE approach_graph_runs SET status = 'cancelled' WHERE ticket_id = ?")
      .run(ticketId);
    const result = graphImplMarkerGuard(store, ticketId);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('cancelled');
    expect(result.reason).toContain('terminal');
    expect(result.reason).toContain('never become marker-ready');
  });

  it('names the blocked reason when a run is blocked, not marker-ready', () => {
    const { ticketId } = markerReadyTicket('GM-BLOCKED');
    store.db
      .prepare(
        "UPDATE approach_graph_runs SET status = 'blocked', blocked_reason = 'graph-budget-exhausted' WHERE ticket_id = ?",
      )
      .run(ticketId);
    const result = graphImplMarkerGuard(store, ticketId);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('blocked');
    expect(result.reason).toContain('graph-budget-exhausted');
  });

  it('uses the real better-sqlite immediate runner before terminal cleanup reads', () => {
    store.close();
    const dir = mkdtempSync(join(tmpdir(), 'karst-run-close-lock-'));
    const dbPath = join(dir, 'karst.db');
    store = openStore(dbPath);
    const { ticketId, graphRunId } = markerReadyTicket('GM-IMMEDIATE');
    const revisionId = (
      store.db
        .prepare('SELECT id FROM approach_graph_revisions WHERE graph_run_id = ?')
        .get(graphRunId) as { id: number }
    ).id;
    const workspaceRoot = nodeWorkspaceDir(dir, 'proj', ticketId, graphRunId, 102);
    const workspaceCwd = join(workspaceRoot, 'api');
    mkdirSync(workspaceCwd, { recursive: true });
    writeFileSync(join(workspaceCwd, 'scratch.txt'), 'lock boundary\n');
    store.db
      .prepare(
        `INSERT INTO approach_node_runs
           (id, graph_run_id, revision_id, node_id, node_kind, visit_number, status)
         VALUES (102, ?, ?, 'done-node', 'agent', 1, 'completed')`,
      )
      .run(graphRunId, revisionId);
    store.db
      .prepare(
        `INSERT INTO approach_graph_workspaces
           (graph_run_id, node_run_id, repo_name, cwd, byte_size, created_at)
         VALUES (?, 102, 'api', ?, 16, '2026-08-12T00:00:00.000Z')`,
      )
      .run(graphRunId, workspaceCwd);
    store.db
      .prepare('UPDATE approach_graph_runs SET workspace_bytes = 16 WHERE id = ?')
      .run(graphRunId);

    const contender = openStore(dbPath);
    contender.db.pragma('busy_timeout = 0');
    const primaryDb = store.db;
    let transactionNumber = 0;
    let cleanupTransactionObserved = false;
    let contenderWasBlocked = false;
    type Tx<T> = (() => T) & {
      default: () => T;
      deferred: () => T;
      immediate: () => T;
      exclusive: () => T;
    };
    const observedDb = new Proxy(primaryDb, {
      get(target, property) {
        if (property === 'transaction') {
          return <T>(fn: () => T): Tx<T> => {
            transactionNumber += 1;
            const observeLock = transactionNumber === 2;
            const body = (): T => {
              if (observeLock) {
                cleanupTransactionObserved = true;
                try {
                  contender.db
                    .prepare('UPDATE tickets SET title = ? WHERE id = ?')
                    .run('contender', ticketId);
                } catch (err) {
                  if (/busy|locked/i.test(err instanceof Error ? err.message : String(err))) {
                    contenderWasBlocked = true;
                  } else {
                    throw err;
                  }
                }
              }
              return fn();
            };
            const transaction = target.transaction(body);
            return Object.assign(
              () => transaction(),
              {
                default: () => transaction.default(),
                deferred: () => transaction.deferred(),
                immediate: () => transaction.immediate(),
                exclusive: () => transaction.exclusive(),
              },
            );
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const observedStore: Store = {
      db: observedDb as Store['db'],
      close: () => {},
    };

    try {
      const result = graphImplMarkerGuard(observedStore, ticketId);

      expect(result).toEqual({ ok: true, graphRunId });
      expect(cleanupTransactionObserved).toBe(true);
      expect(contenderWasBlocked).toBe(true);
    } finally {
      contender.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
      store = openStore(':memory:');
    }
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

describe('fireGraphImplMarkerFromHost', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  function markerReadyTicket(key: string): { ticketId: number; graphRunId: number } {
    store.db.prepare("INSERT OR IGNORE INTO projects (slug) VALUES ('proj')").run();
    const projectId = (
      store.db.prepare("SELECT id FROM projects WHERE slug = 'proj'").get() as { id: number }
    ).id;
    const ticketId = createTicket(store, { key, title: 'thing', projectId }).id;
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
    store.db
      .prepare(
        `INSERT INTO approach_graph_tokens
           (revision_id, source_node_run_id, is_entry, edge_id, destination_node_id,
            destination_end, fork_instance, fork_lineage, status, created_at)
         VALUES (?, NULL, 1, 'e1', 'END', 1, 0, 'root', 'consumed', '2026-08-12T00:00:00.000Z')`,
      )
      .run(revisionId);
    return { ticketId, graphRunId };
  }

  it('fires the marker and advances the ticket when the agent is not waiting', () => {
    const { ticketId, graphRunId } = markerReadyTicket('HM-1');
    store.db.prepare("UPDATE tickets SET agent_state = 'idle' WHERE id = ?").run(ticketId);

    const result = fireGraphImplMarkerFromHost(store, ticketId);

    expect(result.ok).toBe(true);
    expect(result.graphRunId).toBe(graphRunId);
    const ticket = store.db.prepare('SELECT stage_current FROM tickets WHERE id = ?').get(ticketId) as {
      stage_current: string;
    };
    expect(ticket.stage_current).toBe('uat');
  });

  it('refuses without mutating anything while the agent is waiting for the user', () => {
    const { ticketId, graphRunId } = markerReadyTicket('HM-2');
    store.db.prepare("UPDATE tickets SET agent_state = 'waiting' WHERE id = ?").run(ticketId);

    const result = fireGraphImplMarkerFromHost(store, ticketId);

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/waiting for your input/);
    const run = store.db.prepare('SELECT status FROM approach_graph_runs WHERE id = ?').get(graphRunId) as {
      status: string;
    };
    expect(run.status).toBe('completed-awaiting-impl-marker');
    const ticket = store.db.prepare('SELECT stage_current FROM tickets WHERE id = ?').get(ticketId) as {
      stage_current: string;
    };
    expect(ticket.stage_current).toBe('impl');
  });
});

describe('graphApproachMissingRun', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  it('is true for a built-in graph-approach ticket with no graph run at all', () => {
    const ticketId = createTicket(store, { key: 'NR-1', title: 'thing' }).id;
    store.db.prepare('UPDATE tickets SET approach = ? WHERE id = ?').run(BUILT_IN_PACKAGE_ID, ticketId);
    expect(graphApproachMissingRun(store, ticketId)).toBe(true);
  });

  it('is false for a non-graph-approach ticket (unaffected legitimate path)', () => {
    const ticketId = createTicket(store, { key: 'NR-2', title: 'thing' }).id;
    store.db.prepare('UPDATE tickets SET approach = ? WHERE id = ?').run('single-subagent', ticketId);
    expect(graphApproachMissingRun(store, ticketId)).toBe(false);
  });

  it('is false for a ticket with no approach at all', () => {
    const ticketId = createTicket(store, { key: 'NR-3', title: 'thing' }).id;
    expect(graphApproachMissingRun(store, ticketId)).toBe(false);
  });

  it('is false once a graph run exists, whatever its status', () => {
    const ticketId = createTicket(store, { key: 'NR-4', title: 'thing' }).id;
    store.db.prepare('UPDATE tickets SET approach = ? WHERE id = ?').run(BUILT_IN_PACKAGE_ID, ticketId);
    const attempt = stageAttempt(store, ticketId, 'impl');
    store.db
      .prepare(
        `INSERT INTO approach_graph_runs (ticket_id, stage_key, stage_attempt, approach_id, status, created_at)
         VALUES (?, 'impl', ?, 'x', 'planning', '2026-08-12T00:00:00.000Z')`,
      )
      .run(ticketId, attempt);
    expect(graphApproachMissingRun(store, ticketId)).toBe(false);
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

  it('names the per-ticket run ordinal, the same number the panel shows, never the global row id', () => {
    // The reported confusion: the impl banner read "(graph run 5)" beside an
    // Inside strip reading "run 1" — the banner was printing the registry row
    // id while every other surface prints the ticket's own ordinal.
    const other = createTicket(store, { key: 'BG-ORD-0', title: 'other' }).id;
    store.db
      .prepare(
        `INSERT INTO approach_graph_runs (ticket_id, stage_key, stage_attempt, approach_id, status, created_at)
         VALUES (?, 'impl', 0, 'x', 'cancelled', '2026-08-12T00:00:00.000Z')`,
      )
      .run(other);
    const ticketId = createTicket(store, { key: 'BG-ORD-1', title: 'thing' }).id;
    store.db.prepare("UPDATE tickets SET stage_current = 'impl' WHERE id = ?").run(ticketId);
    const graphRunId = Number(
      store.db
        .prepare(
          `INSERT INTO approach_graph_runs (ticket_id, stage_key, stage_attempt, approach_id, status, blocked_reason, created_at)
           VALUES (?, 'impl', 0, 'x', 'blocked', 'graph-plan-invalid', '2026-08-12T00:00:00.000Z')`,
        )
        .run(ticketId)
        .lastInsertRowid,
    );
    expect(graphRunId).toBeGreaterThan(1);
    blockGraphStage(store, ticketId, graphRunId, () => '2026-08-12T00:00:00.000Z');
    expect(stageBlock(store, ticketId, 'impl')?.reason).toContain('graph run 1)');
  });

  it('names the EARLIEST fault by durable event order among concurrent node faults (Slice 5 T6)', () => {
    const ticketId = createTicket(store, { key: 'BG-3', title: 'thing' }).id;
    store.db.prepare("UPDATE tickets SET stage_current = 'impl' WHERE id = ?").run(ticketId);
    const graphRunId = Number(
      store.db
        .prepare(
          `INSERT INTO approach_graph_runs (ticket_id, stage_key, stage_attempt, approach_id, status, blocked_reason, created_at)
           VALUES (?, 'impl', 0, 'x', 'blocked', 'node-blocked: node 7 (a later fault won the block)', '2026-08-12T00:00:00.000Z')`,
        )
        .run(ticketId)
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
    // Three concurrent node faults; the run's OWN blocked_reason names a
    // LATER fault (node run 7) — the stage block must name the EARLIEST by
    // durable event order (the lowest node-run id: 5).
    const nodes: [number, string, string][] = [
      [5, 'blocked', 'integration-conflict: b.ts'],
      [6, 'failed-to-launch', 'spawn refused'],
      [7, 'blocked', 'node 7 fault'],
    ];
    for (const [id, status, reason] of nodes) {
      store.db
        .prepare(
          `INSERT INTO approach_node_runs
             (id, graph_run_id, revision_id, node_id, node_kind, visit_number, status, reason, outcome)
           VALUES (?, ?, ?, 'n', 'agent', ?, ?, ?, ?)`,
        )
        .run(id, graphRunId, revisionId, id, status, reason, status === 'blocked' ? 'blocked' : null);
    }
    blockGraphStage(store, ticketId, graphRunId, () => '2026-08-12T00:00:00.000Z');
    const block = stageBlock(store, ticketId, 'impl');
    expect(block?.kind).toBe(GRAPH_FAILED_BLOCKER);
    expect(block?.reason).toContain('node 5');
    expect(block?.reason).toContain('integration-conflict: b.ts');
    expect(block?.reason).not.toContain('node 7 (a later fault won the block)');
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
