/**
 * Reload and crash matrix tests (Slice 4 Task 3).
 *
 * One test per matrix row, plus the successor-run staleness rule and the
 * "another window's live process left alone" row. The decision logic is pure:
 * process facts, sessions and the resume pipeline are injected fakes, so no
 * real probe or transport is ever touched.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../../../store/db.js';
import type { GraphDb } from '../../../store/graph/transitions.js';
import type { ProcessFactsSource, LiveCwd } from '../../../runtime/serverIdentity.js';
import { acquireLease } from '../../../store/graph/leases.js';
import { recoverGraphRun, type RecoveryDeps } from './recovery.js';
import { reconcileGraphRun, type ReconcileGraphRunDeps } from './reconcile.js';

const NOW = '2026-08-12T00:00:00.000Z';

interface Ctx {
  store: Store;
  db: ReturnType<typeof openStore>['db'];
  ticketId: number;
  graphRunId: number;
  revisionId: number;
  makeDeps: (overrides?: Partial<ReconcileGraphRunDeps>) => ReconcileGraphRunDeps;
}

/** BEGIN IMMEDIATE wrapper: the installed @types predate the `{begin}` option
 *  (runtime better-sqlite3 12.x supports it), so the option is cast once. */
function withImmediate<T>(db: ReturnType<typeof openStore>['db'], fn: () => T): T {
  const runner = (db.transaction as unknown as (f: () => T, o: { begin: 'immediate' }) => () => T)(
    fn,
    { begin: 'immediate' },
  );
  return runner();
}

function makeFacts(f: {
  alive?: Record<number, boolean>;
  startMs?: Record<number, number | null>;
  cwd?: Record<number, LiveCwd | null>;
}): ProcessFactsSource {
  return {
    isAlive: async (pid) => f.alive?.[pid] ?? true,
    liveCwd: async (pid) => f.cwd?.[pid] ?? null,
    processStartMs: async (pid) => f.startMs?.[pid] ?? null,
  };
}

function setup(db: ReturnType<typeof openStore>['db']): { ticketId: number; graphRunId: number; revisionId: number } {
  const ticketId = Number(
    db.prepare("INSERT INTO tickets (key) VALUES ('RC-1')").run().lastInsertRowid,
  );
  db.prepare("UPDATE tickets SET stage_current = 'impl' WHERE id = ?").run(ticketId);
  const graphRunId = Number(
    db
      .prepare(
        `INSERT INTO approach_graph_runs (ticket_id, stage_key, stage_attempt, approach_id, status, created_at)
         VALUES (?, 'impl', 0, 'x', 'running', ?)`,
      )
      .run(ticketId, NOW)
      .lastInsertRowid,
  );
  const revisionId = Number(
    db
      .prepare(
        `INSERT INTO approach_graph_revisions
           (graph_run_id, revision_number, canonical_graph, fingerprint, status, created_at)
         VALUES (?, 1, '{}', 'fp', 'active', ?)`,
      )
      .run(graphRunId, NOW)
      .lastInsertRowid,
  );
  return { ticketId, graphRunId, revisionId };
}

function harness(): Ctx {
  const store = openStore(':memory:');
  const db = store.db;
  const { ticketId, graphRunId, revisionId } = setup(db);
  const base: ReconcileGraphRunDeps = {
    db,
    transaction: <T>(fn: () => T): T => withImmediate(db, fn),
    now: () => NOW,
    debug: () => {},
    facts: makeFacts({}),
    sessionFor: () => undefined,
    resumePipeline: () => {},
  };
  return {
    store,
    db,
    ticketId,
    graphRunId,
    revisionId,
    makeDeps: (overrides) => ({ ...base, ...overrides }),
  };
}

function insertNodeRun(
  ctx: Ctx,
  id: number,
  status: string,
  extra: { ownerNonce?: string | null; processRunId?: number | null } = {},
): void {
  ctx.db
    .prepare(
      `INSERT INTO approach_node_runs
         (id, graph_run_id, revision_id, node_id, node_kind, visit_number, status, owner_nonce, process_run_id)
       VALUES (?, ?, ?, 'n', 'agent', ?, ?, ?, ?)`,
    )
    .run(id, ctx.graphRunId, ctx.revisionId, id, status, extra.ownerNonce ?? null, extra.processRunId ?? null);
}
/** Open a process_runs row (pid) and link it to the node run. */
function linkProcess(ctx: Ctx, processRunId: number, pid: number | null, startedAt = NOW): void {
  ctx.db
    .prepare(
      `INSERT INTO process_runs
         (id, ticket_id, stage_key, process_id, attempt, pid, status, started_at)
       VALUES (?, ?, 'impl', 'graph-node', 0, ?, 'running', ?)`,
    )
    .run(processRunId, ctx.ticketId, pid, startedAt);
  ctx.db
    .prepare('UPDATE approach_node_runs SET process_run_id = ? WHERE id = ?')
    .run(processRunId, processRunId);
}

/** Move the fixture's graph run to `planning` (the bootstrap phase). */
function toPlanning(ctx: Ctx): void {
  ctx.db.prepare("UPDATE approach_graph_runs SET status = 'planning' WHERE id = ?").run(ctx.graphRunId);
}

/** Insert a bootstrap planner run linked to a process run, returning the id. */
function insertBootstrapPlanner(
  ctx: Ctx,
  id: number,
  status: string,
  extra: { processRunId?: number | null } = {},
): void {
  ctx.db
    .prepare(
      `INSERT INTO approach_planner_runs
         (id, graph_run_id, planner_run_number, kind, status, process_run_id, started_at)
       VALUES (?, ?, 1, 'bootstrap', ?, ?, ?)`,
    )
    .run(id, ctx.graphRunId, status, extra.processRunId ?? null, NOW);
}

/** Open a process_runs row for a planner run and link it. */
function linkPlannerProcess(ctx: Ctx, processRunId: number, plannerRunId: number, pid: number | null, startedAt = NOW): void {
  ctx.db
    .prepare(
      `INSERT INTO process_runs
         (id, ticket_id, stage_key, process_id, attempt, pid, status, started_at)
       VALUES (?, ?, 'impl', 'graph-planner', 0, ?, 'running', ?)`,
    )
    .run(processRunId, ctx.ticketId, pid, startedAt);
  ctx.db
    .prepare('UPDATE approach_planner_runs SET process_run_id = ? WHERE id = ?')
    .run(processRunId, plannerRunId);
}

function plannerRow(ctx: Ctx, id: number): { status: string } {
  return ctx.db
    .prepare('SELECT status FROM approach_planner_runs WHERE id = ?')
    .get(id) as { status: string };
}

function insertPendingToken(ctx: Ctx, edgeId = 'e1'): number {
  return Number(
    ctx.db
      .prepare(
        `INSERT INTO approach_graph_tokens
           (revision_id, source_node_run_id, is_entry, edge_id, destination_node_id,
            destination_end, fork_instance, fork_lineage, status, created_at)
         VALUES (?, NULL, 1, ?, 'n', 0, 0, 'root', 'pending', ?)`,
      )
      .run(ctx.revisionId, edgeId, NOW)
      .lastInsertRowid,
  );
}

function runRow(ctx: Ctx): { status: string; blocked_reason: string | null } {
  return ctx.db
    .prepare('SELECT status, blocked_reason FROM approach_graph_runs WHERE id = ?')
    .get(ctx.graphRunId) as { status: string; blocked_reason: string | null };
}

function nodeRow(ctx: Ctx, id: number): { status: string; outcome: string | null } {
  return ctx.db
    .prepare('SELECT status, outcome FROM approach_node_runs WHERE id = ?')
    .get(id) as { status: string; outcome: string | null };
}

describe('reconcileGraphRun — reload and crash matrix', () => {
  let ctx: Ctx;
  beforeEach(() => (ctx = harness()));
  afterEach(() => ctx.store.close());

  it('a running node with a live attributable process is left alone (another window owns it)', async () => {
    linkProcess(ctx, 101, 4242, NOW);
    insertNodeRun(ctx, 101, 'running', { processRunId: 101 });
    const deps = ctx.makeDeps({
      facts: makeFacts({ alive: { 4242: true }, startMs: { 4242: Date.parse(NOW) } }),
    });
    const result = await reconcileGraphRun(deps, { graphRunId: ctx.graphRunId });
    expect(nodeRow(ctx, 101).status).toBe('running');
    expect(runRow(ctx).status).toBe('running');
    expect(result.transitions).toBe(0);
  });

  it('a node with no pid evidence is never declared dead merely because this window cannot see its terminal', async () => {
    insertNodeRun(ctx, 102, 'running', { processRunId: null });
    const result = await reconcileGraphRun(ctx.makeDeps(), { graphRunId: ctx.graphRunId });
    expect(nodeRow(ctx, 102).status).toBe('running');
    expect(runRow(ctx).status).toBe('running');
    // A process_runs row whose pid is null (the terminal never started) is
    // equally no evidence of death.
    linkProcess(ctx, 103, null);
    insertNodeRun(ctx, 103, 'running', { processRunId: 103 });
    await reconcileGraphRun(ctx.makeDeps(), { graphRunId: ctx.graphRunId });
    expect(nodeRow(ctx, 103).status).toBe('running');
    expect(result.transitions).toBe(0);
  });

  it('a launching node with an owner nonce but no identity is provably retryable via recovery', async () => {
    insertNodeRun(ctx, 104, 'launching', { ownerNonce: 'nonce-1' });
    const result = await reconcileGraphRun(ctx.makeDeps(), { graphRunId: ctx.graphRunId });
    expect(nodeRow(ctx, 104).status).toBe('blocked');
    const run = runRow(ctx);
    expect(run.status).toBe('blocked');
    expect(run.blocked_reason).toMatch(/node-blocked/);
    // The recoverable blocker: the typed recovery action relaunches it.
    const recovery = recoverGraphRun(
      { store: ctx.store, transaction: ctx.makeDeps().transaction, now: () => NOW, debug: () => {} } satisfies RecoveryDeps,
      { ticketId: ctx.ticketId, graphRunId: ctx.graphRunId },
    );
    expect(recovery.kind).toBe('retried');
    expect(nodeRow(ctx, 104).status).toBe('launching');
    expect(result.transitions).toBe(1);
  });

  it('a launching node with no owner nonce is launch-unknown and blocks the run', async () => {
    insertNodeRun(ctx, 105, 'launching', { ownerNonce: null });
    const result = await reconcileGraphRun(ctx.makeDeps(), { graphRunId: ctx.graphRunId });
    expect(nodeRow(ctx, 105).status).toBe('launch-unknown');
    const run = runRow(ctx);
    expect(run.status).toBe('blocked');
    expect(run.blocked_reason).toMatch(/launch-unknown/);
    expect(result.transitions).toBe(1);
  });

  it('a running node whose process is demonstrably dead is marked stale and the run blocks recoverably', async () => {
    linkProcess(ctx, 106, 4343, NOW);
    insertNodeRun(ctx, 106, 'running', { processRunId: 106 });
    const deps = ctx.makeDeps({
      facts: makeFacts({ alive: { 4343: false } }),
    });
    const result = await reconcileGraphRun(deps, { graphRunId: ctx.graphRunId });
    expect(nodeRow(ctx, 106).status).toBe('stale');
    const run = runRow(ctx);
    expect(run.status).toBe('blocked');
    expect(run.blocked_reason).toMatch(/node-blocked/);
    expect(result.transitions).toBe(1);
  });

  it('a running node whose process death is unprovable becomes termination-unknown and its lease is marked ambiguous-process', async () => {
    linkProcess(ctx, 107, 4444, NOW);
    insertNodeRun(ctx, 107, 'running', { processRunId: 107 });
    acquireLease(ctx.db, {
      graphRunId: ctx.graphRunId,
      ownerNodeRunId: 107,
      physicalDomain: 'dom',
      accessMode: 'exclusive',
      claimedPaths: null,
      now: NOW,
    });
    const deps = ctx.makeDeps({
      facts: makeFacts({ alive: { 4444: true }, startMs: { 4444: null } }),
    });
    const result = await reconcileGraphRun(deps, { graphRunId: ctx.graphRunId });
    expect(nodeRow(ctx, 107).status).toBe('termination-unknown');
    // The lease flips `ambiguous-process` exactly here (Slice 5 T2) — a
    // conflicting launch is blocked and no automatic release may move it.
    const lease = ctx.db
      .prepare('SELECT status FROM approach_resource_leases WHERE owner_node_run_id = ?')
      .get(107) as { status: string };
    expect(lease.status).toBe('ambiguous-process');
    expect(runRow(ctx).status).toBe('running');
    expect(result.transitions).toBe(1);
  });

  it('a completing node with a dead process resumes the completion pipeline where it stopped', async () => {
    linkProcess(ctx, 108, 4545, NOW);
    insertNodeRun(ctx, 108, 'completing', { processRunId: 108 });
    const resumed: number[] = [];
    const deps = ctx.makeDeps({
      facts: makeFacts({ alive: { 4545: false } }),
      resumePipeline: (nodeRunId) => resumed.push(nodeRunId),
    });
    const result = await reconcileGraphRun(deps, { graphRunId: ctx.graphRunId });
    expect(resumed).toEqual([108]);
    expect(nodeRow(ctx, 108).status).toBe('completing');
    expect(result.resumed).toEqual([108]);
  });

  it('an integrating node with a dead process resumes the completion pipeline where it stopped', async () => {
    linkProcess(ctx, 109, 4646, NOW);
    insertNodeRun(ctx, 109, 'integrating', { processRunId: 109 });
    const resumed: number[] = [];
    const deps = ctx.makeDeps({
      facts: makeFacts({ alive: { 4646: false } }),
      resumePipeline: (nodeRunId) => resumed.push(nodeRunId),
    });
    const result = await reconcileGraphRun(deps, { graphRunId: ctx.graphRunId });
    expect(resumed).toEqual([109]);
    expect(result.resumed).toEqual([109]);
  });

  it('a completing node with a live attributable process reverts to running and completion proceeds', async () => {
    linkProcess(ctx, 110, 4747, NOW);
    insertNodeRun(ctx, 110, 'completing', { processRunId: 110 });
    const deps = ctx.makeDeps({
      facts: makeFacts({ alive: { 4747: true }, startMs: { 4747: Date.parse(NOW) } }),
    });
    const result = await reconcileGraphRun(deps, { graphRunId: ctx.graphRunId });
    expect(nodeRow(ctx, 110).status).toBe('running');
    expect(result.reverted).toEqual([110]);
  });

  it('an integrating node with a live attributable process reverts to running', async () => {
    linkProcess(ctx, 111, 4848, NOW);
    insertNodeRun(ctx, 111, 'integrating', { processRunId: 111 });
    const deps = ctx.makeDeps({
      facts: makeFacts({ alive: { 4848: true }, startMs: { 4848: Date.parse(NOW) } }),
    });
    const result = await reconcileGraphRun(deps, { graphRunId: ctx.graphRunId });
    expect(nodeRow(ctx, 111).status).toBe('running');
    expect(result.reverted).toEqual([111]);
  });

  it('a completed node whose successor tokens committed is scheduled exactly once', async () => {
    insertNodeRun(ctx, 112, 'completed', { processRunId: null });
    insertPendingToken(ctx, 'succ-1');
    const result = await reconcileGraphRun(ctx.makeDeps(), { graphRunId: ctx.graphRunId });
    expect(nodeRow(ctx, 112).status).toBe('completed');
    const tokens = ctx.db
      .prepare('SELECT COUNT(*) AS n FROM approach_graph_tokens WHERE status = ?')
      .get('pending') as { n: number };
    expect(tokens.n).toBe(1);
    expect(result.transitions).toBe(0);
  });

  it('pending non-conflicting tokens resume scheduling untouched', async () => {
    insertPendingToken(ctx, 't1');
    insertPendingToken(ctx, 't2');
    const result = await reconcileGraphRun(ctx.makeDeps(), { graphRunId: ctx.graphRunId });
    const pending = ctx.db
      .prepare("SELECT COUNT(*) AS n FROM approach_graph_tokens WHERE status = 'pending'")
      .get() as { n: number };
    expect(pending.n).toBe(2);
    expect(result.transitions).toBe(0);
  });

  it('a draining revision is left to wait for active work, then replanning continues', async () => {
    ctx.db
      .prepare("UPDATE approach_graph_revisions SET status = 'draining' WHERE id = ?")
      .run(ctx.revisionId);
    insertNodeRun(ctx, 113, 'running', { processRunId: null });
    const result = await reconcileGraphRun(ctx.makeDeps(), { graphRunId: ctx.graphRunId });
    expect(nodeRow(ctx, 113).status).toBe('running');
    expect(runRow(ctx).status).toBe('running');
    expect(result.transitions).toBe(0);
  });

  it('a blocked graph stays blocked until Resume/config change', async () => {
    ctx.db
      .prepare("UPDATE approach_graph_runs SET status = 'blocked', blocked_reason = 'node-blocked: x' WHERE id = ?")
      .run(ctx.graphRunId);
    const result = await reconcileGraphRun(ctx.makeDeps(), { graphRunId: ctx.graphRunId });
    expect(runRow(ctx)).toMatchObject({ status: 'blocked', blocked_reason: 'node-blocked: x' });
    expect(result.transitions).toBe(0);
  });

  it('a completed graph at impl stays awaiting the explicit marker', async () => {
    ctx.db
      .prepare("UPDATE approach_graph_runs SET status = 'completed-awaiting-impl-marker' WHERE id = ?")
      .run(ctx.graphRunId);
    const result = await reconcileGraphRun(ctx.makeDeps(), { graphRunId: ctx.graphRunId });
    expect(runRow(ctx).status).toBe('completed-awaiting-impl-marker');
    expect(result.transitions).toBe(0);
  });

  it('a ticket no longer at impl cancels unscheduled tokens and prevents new graph work without rewriting completed evidence', async () => {
    ctx.db.prepare("UPDATE tickets SET stage_current = 'uat' WHERE id = ?").run(ctx.ticketId);
    insertPendingToken(ctx, 'doomed');
    insertNodeRun(ctx, 114, 'completed', { processRunId: null });
    const result = await reconcileGraphRun(ctx.makeDeps(), { graphRunId: ctx.graphRunId });
    const pending = ctx.db
      .prepare("SELECT COUNT(*) AS n FROM approach_graph_tokens WHERE status = 'pending'")
      .get() as { n: number };
    expect(pending.n).toBe(0);
    expect(runRow(ctx).status).toBe('cancelled');
    // Completed evidence is never rewritten.
    expect(nodeRow(ctx, 114).status).toBe('completed');
    expect(result.cancelledTokens).toBe(1);
  });

  it('a non-terminal run with a successor run is marked stale (the earlier host died)', async () => {
    ctx.db
      .prepare(
        `INSERT INTO approach_graph_runs (ticket_id, stage_key, stage_attempt, approach_id, status, created_at)
         VALUES (?, 'impl', 1, 'x', 'running', ?)`,
      )
      .run(ctx.ticketId, NOW);
    const result = await reconcileGraphRun(ctx.makeDeps(), { graphRunId: ctx.graphRunId });
    expect(runRow(ctx).status).toBe('stale');
    expect(result.transitions).toBe(0);
  });

  it('a superseded run with a live process in another window is left strictly alone', async () => {
    ctx.db
      .prepare(
        `INSERT INTO approach_graph_runs (ticket_id, stage_key, stage_attempt, approach_id, status, created_at)
         VALUES (?, 'impl', 1, 'x', 'running', ?)`,
      )
      .run(ctx.ticketId, NOW);
    linkProcess(ctx, 115, 4949, NOW);
    insertNodeRun(ctx, 115, 'running', { processRunId: 115 });
    const deps = ctx.makeDeps({
      facts: makeFacts({ alive: { 4949: true }, startMs: { 4949: Date.parse(NOW) } }),
    });
    const result = await reconcileGraphRun(deps, { graphRunId: ctx.graphRunId });
    expect(runRow(ctx).status).toBe('running');
    expect(result.transitions).toBe(0);
  });

  it('a planning run whose bootstrap planner process is demonstrably dead blocks the run recoverably and marks the planner stale', async () => {
    toPlanning(ctx);
    linkPlannerProcess(ctx, 201, 201, 4243, NOW);
    insertBootstrapPlanner(ctx, 201, 'running', { processRunId: 201 });
    const deps = ctx.makeDeps({
      facts: makeFacts({ alive: { 4243: false } }),
    });
    const result = await reconcileGraphRun(deps, { graphRunId: ctx.graphRunId });
    expect(plannerRow(ctx, 201).status).toBe('stale');
    const run = runRow(ctx);
    expect(run.status).toBe('blocked');
    expect(run.blocked_reason).toMatch(/planner-stale/);
    expect(result.transitions).toBe(1);
    expect(result.status).toBe('blocked');
  });

  it('a planning run whose bootstrap planner has a live attributable process is left alone (another window owns it)', async () => {
    toPlanning(ctx);
    linkPlannerProcess(ctx, 202, 202, 4244, NOW);
    insertBootstrapPlanner(ctx, 202, 'running', { processRunId: 202 });
    const deps = ctx.makeDeps({
      facts: makeFacts({ alive: { 4244: true }, startMs: { 4244: Date.parse(NOW) } }),
    });
    const result = await reconcileGraphRun(deps, { graphRunId: ctx.graphRunId });
    expect(plannerRow(ctx, 202).status).toBe('running');
    expect(runRow(ctx).status).toBe('planning');
    expect(result.transitions).toBe(0);
  });

  it('a planning run whose bootstrap planner has no pid evidence is never declared dead', async () => {
    toPlanning(ctx);
    insertBootstrapPlanner(ctx, 203, 'running', { processRunId: null });
    const result = await reconcileGraphRun(ctx.makeDeps(), { graphRunId: ctx.graphRunId });
    expect(plannerRow(ctx, 203).status).toBe('running');
    expect(runRow(ctx).status).toBe('planning');
    expect(result.transitions).toBe(0);
  });

  it('a planning run whose bootstrap planner process death is unprovable is left alone', async () => {
    toPlanning(ctx);
    linkPlannerProcess(ctx, 204, 204, 4246, NOW);
    insertBootstrapPlanner(ctx, 204, 'running', { processRunId: 204 });
    const deps = ctx.makeDeps({
      facts: makeFacts({ alive: { 4246: true }, startMs: { 4246: null } }),
    });
    const result = await reconcileGraphRun(deps, { graphRunId: ctx.graphRunId });
    expect(plannerRow(ctx, 204).status).toBe('running');
    expect(runRow(ctx).status).toBe('planning');
    expect(result.transitions).toBe(0);
  });
});
