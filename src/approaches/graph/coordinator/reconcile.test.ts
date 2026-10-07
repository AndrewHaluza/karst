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
import { electReplan } from './replan.js';
import { ACTIVE_NODE_STATUSES } from './completion.js';
import { countNodeRunsInStatusesForGraphRun } from '../../../store/graph/nodeRuns.js';

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
    relaunchPlanner: () => {},
    relaunchReplanPlanner: () => {},
    relaunchCompileRepair: () => {},
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

/** Park the graph run (and its revision) at `draining` — the state a replan
 *  planner works in, and the one status with no exit but replan acceptance. */
function toDraining(ctx: Ctx): void {
  ctx.db.prepare("UPDATE approach_graph_runs SET status = 'draining' WHERE id = ?").run(ctx.graphRunId);
  ctx.db.prepare("UPDATE approach_graph_revisions SET status = 'draining' WHERE id = ?").run(ctx.revisionId);
}

/** Park the graph run at `planning` (the state the bootstrap planner works in). */
function toPlanning(ctx: Ctx): void {
  ctx.db.prepare("UPDATE approach_graph_runs SET status = 'planning' WHERE id = ?").run(ctx.graphRunId);
}

/** Insert a planner run row for the graph run (bootstrap unless told otherwise).
 *  A replan planner defaults to target revision 2 — the successor of the
 *  harness's revision 1, i.e. "this drain". A test that wants a PRIOR drain's
 *  planner inserts it directly with its own target. */
function insertPlannerRun(
  ctx: Ctx,
  id: number,
  status: string,
  extra: {
    ownerNonce?: string | null;
    processRunId?: number | null;
    plannerRunNumber?: number;
    kind?: 'bootstrap' | 'replan';
    targetRevisionNumber?: number | null;
  } = {},
): void {
  const kind = extra.kind ?? 'bootstrap';
  // An explicit `null` target means a LEGACY row and must NOT be coalesced
  // into the default, so test `!== undefined` rather than `??`.
  const targetRevisionNumber =
    extra.targetRevisionNumber !== undefined
      ? extra.targetRevisionNumber
      : kind === 'replan'
        ? 2
        : null;
  ctx.db
    .prepare(
      `INSERT INTO approach_planner_runs
         (id, graph_run_id, planner_run_number, kind, target_revision_number, status, owner_nonce, process_run_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      ctx.graphRunId,
      extra.plannerRunNumber ?? 1,
      kind,
      targetRevisionNumber,
      status,
      extra.ownerNonce ?? null,
      extra.processRunId ?? null,
    );
}
/** Open a process_runs row (pid) and link it to the planner run. */
function linkPlannerProcess(
  ctx: Ctx,
  processRunId: number,
  plannerRunId: number,
  pid: number | null,
  startedAt = NOW,
): void {
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

  it('a launching node with no owner nonce and no process is the recovery-rearmed retry — reconcile leaves it alone', async () => {
    insertNodeRun(ctx, 105, 'launching', { ownerNonce: null });
    const result = await reconcileGraphRun(ctx.makeDeps(), { graphRunId: ctx.graphRunId });
    // The armed retry shape is waiting for the driver's periodic relaunch:
    // `driveReadyNodeRuns` selects exactly `launching` + no owner nonce + no
    // process as launchable (the recovery armed it by clearing the dead
    // attempt's identity). Parking it re-blocks the run the recovery just
    // un-blocked — in a multi-window setup another window's reconcile can land
    // between the retry and the relaunch, so a Resume reads as "did nothing"
    // and the user has to click again. Reconcile never parks it.
    expect(nodeRow(ctx, 105).status).toBe('launching');
    const run = runRow(ctx);
    expect(run.status).toBe('running');
    expect(run.blocked_reason).toBeNull();
    expect(result.transitions).toBe(0);
  });

  it('a Resume-armed node is never re-blocked by a concurrent window reconcile — the Resume loop regression', async () => {
    // The reported loop: "Resume to relaunch the reserved visit worked only
    // from the Nth time". The recovery arms the node (`blocked → launching`,
    // dead identity cleared) and the run (`blocked → running`); a SECOND
    // window's reconcile pass — which has no session for the node and sees the
    // armed `launching` shape — must not re-block it. Parking would turn the
    // relaunch into a re-click loop exactly as observed.
    insertNodeRun(ctx, 120, 'blocked', { ownerNonce: null });
    ctx.db.prepare("UPDATE approach_graph_runs SET status = 'blocked', blocked_reason = ? WHERE id = ?")
      .run('node-blocked: node 120 process (pid 2214) is gone (dead at reconcile) — Resume to relaunch the reserved visit', ctx.graphRunId);
    const recovery = recoverGraphRun(
      { store: ctx.store, transaction: ctx.makeDeps().transaction, now: () => NOW, debug: () => {} } satisfies RecoveryDeps,
      { ticketId: ctx.ticketId, graphRunId: ctx.graphRunId },
    );
    expect(recovery.kind).toBe('retried');
    expect(nodeRow(ctx, 120).status).toBe('launching');

    // Another window's reconcile observes the armed node: no session, no pid,
    // no owner nonce — the exact shape reconcile used to park as
    // "no launch identity". It must leave it for the driver.
    const secondWindow = await reconcileGraphRun(ctx.makeDeps(), { graphRunId: ctx.graphRunId });
    expect(secondWindow.transitions).toBe(0);
    expect(nodeRow(ctx, 120).status).toBe('launching');
    const run = runRow(ctx);
    expect(run.status).toBe('running');
    expect(run.blocked_reason).toBeNull();
  });

  it('states the CURRENT cause on the node it blocks — never a reason left by an earlier park', async () => {
    // The node's own `reason` is what the Inside graph view renders per node
    // (`ui/dashboard/graphInside.ts`). A node parked once (here: a launch
    // failure) and blocked LATER for an unrelated cause kept the first
    // reason, so the row named a cause that was no longer true while the
    // run-level `blocked_reason` named the real one.
    insertNodeRun(ctx, 110, 'launching', { ownerNonce: 'nonce-1' });
    ctx.db
      .prepare("UPDATE approach_node_runs SET reason = 'stop-drained-orphan' WHERE id = ?")
      .run(110);

    await reconcileGraphRun(ctx.makeDeps(), { graphRunId: ctx.graphRunId });

    const node = ctx.db
      .prepare('SELECT status, reason FROM approach_node_runs WHERE id = ?')
      .get(110) as { status: string; reason: string | null };
    expect(node.status).toBe('blocked');
    expect(node.reason).not.toBe('stop-drained-orphan');
    expect(node.reason).toMatch(/crashed before spawn/);
    // …and it is the same cause the run-level block reports.
    expect(runRow(ctx).blocked_reason).toContain(node.reason!);
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

  it('a run running with a draining revision and no active revision is re-drained for replan recovery', async () => {
    // The stranded shape Stop/Start produced over an in-flight replan: the
    // election had drained the revision and the run was flipped back to
    // `running`, so step 3's draining-revision no-op would strand it forever.
    ctx.db
      .prepare("UPDATE approach_graph_revisions SET status = 'draining' WHERE id = ?")
      .run(ctx.revisionId);
    insertNodeRun(ctx, 113, 'running', { processRunId: null });
    const relaunched: number[] = [];
    const result = await reconcileGraphRun(
      ctx.makeDeps({ relaunchReplanPlanner: (graphRunId) => relaunched.push(graphRunId) }),
      { graphRunId: ctx.graphRunId },
    );
    expect(runRow(ctx).status).toBe('draining');
    // The abandoned revision's still-active node run is cancelled — otherwise
    // the replan planner's quiescence gate can never pass and the repair
    // re-strands (the exact strand this ticket fixes).
    expect(nodeRow(ctx, 113).status).toBe('cancelled');
    const active = countNodeRunsInStatusesForGraphRun(
      ctx.db,
      ctx.graphRunId,
      ACTIVE_NODE_STATUSES,
    );
    expect(active).toBe(0); // quiescent — a planner CAN now be allocated
    expect(relaunched).toEqual([ctx.graphRunId]);
    expect(result.transitions).toBe(2); // run re-drained + node cancelled
  });

  it('cancels a dead-process node on the abandoned revision so the replan planner can allocate', async () => {
    // The reviewer's exact repro: node X `running` behind a dead pid. The
    // self-heal must clear it, or `beginReplanPlannerRun` answers
    // `not-quiescent` forever and the run stays stranded in `draining`.
    ctx.db
      .prepare("UPDATE approach_graph_revisions SET status = 'draining' WHERE id = ?")
      .run(ctx.revisionId);
    linkProcess(ctx, 116, 7777, NOW);
    insertNodeRun(ctx, 116, 'running', { processRunId: 116 });
    const relaunched: number[] = [];
    const result = await reconcileGraphRun(
      ctx.makeDeps({
        facts: makeFacts({ alive: { 7777: false } }),
        relaunchReplanPlanner: (graphRunId) => relaunched.push(graphRunId),
      }),
      { graphRunId: ctx.graphRunId },
    );
    expect(runRow(ctx).status).toBe('draining');
    expect(nodeRow(ctx, 116).status).toBe('cancelled');
    expect(
      countNodeRunsInStatusesForGraphRun(ctx.db, ctx.graphRunId, ACTIVE_NODE_STATUSES),
    ).toBe(0);
    expect(relaunched).toEqual([ctx.graphRunId]);
    expect(result.transitions).toBe(2);
  });

  it('leaves a live attributable node alone when self-healing (never orphans another window’s process)', async () => {
    ctx.db
      .prepare("UPDATE approach_graph_revisions SET status = 'draining' WHERE id = ?")
      .run(ctx.revisionId);
    linkProcess(ctx, 117, 4242, NOW);
    insertNodeRun(ctx, 117, 'running', { processRunId: 117 });
    const result = await reconcileGraphRun(
      ctx.makeDeps({
        facts: makeFacts({ alive: { 4242: true }, startMs: { 4242: Date.parse(NOW) } }),
      }),
      { graphRunId: ctx.graphRunId },
    );
    // The run is still re-drained, but the live node is NOT cancelled.
    expect(runRow(ctx).status).toBe('draining');
    expect(nodeRow(ctx, 117).status).toBe('running');
    expect(result.transitions).toBe(1);
  });

  it('leaves an unprovable (live-but-unattributable) node alone when self-healing', async () => {
    // attributeServer returns 'unknown' when the pid is alive but its identity
    // cannot be established (no start-time evidence). Cancelling it would orphan
    // a live agent — every other branch parks this as termination-unknown.
    ctx.db
      .prepare("UPDATE approach_graph_revisions SET status = 'draining' WHERE id = ?")
      .run(ctx.revisionId);
    linkProcess(ctx, 118, 4343, NOW);
    insertNodeRun(ctx, 118, 'running', { processRunId: 118 });
    const result = await reconcileGraphRun(
      ctx.makeDeps({ facts: makeFacts({ alive: { 4343: true } }) }),
      { graphRunId: ctx.graphRunId },
    );
    expect(runRow(ctx).status).toBe('draining');
    expect(nodeRow(ctx, 118).status).toBe('running');
    expect(result.transitions).toBe(1);
  });

  it('resumes (never cancels) a completing node on the abandoned revision when self-healing', async () => {
    // A `completing` node's outcome is already in hand; cancelling it would skip
    // the completion pipeline's artifact recording. Resume it instead — the
    // running-gated node sweep can never reach it once the run is `draining`.
    ctx.db
      .prepare("UPDATE approach_graph_revisions SET status = 'draining' WHERE id = ?")
      .run(ctx.revisionId);
    linkProcess(ctx, 119, 4546, NOW);
    insertNodeRun(ctx, 119, 'completing', { processRunId: 119 });
    const resumed: number[] = [];
    const result = await reconcileGraphRun(
      ctx.makeDeps({
        facts: makeFacts({ alive: { 4546: false } }),
        resumePipeline: (nodeRunId) => resumed.push(nodeRunId),
      }),
      { graphRunId: ctx.graphRunId },
    );
    expect(runRow(ctx).status).toBe('draining');
    expect(nodeRow(ctx, 119).status).toBe('completing'); // NOT cancelled
    expect(resumed).toEqual([119]);
    expect(result.transitions).toBe(1); // only the run re-drain
  });

  it('releases a cancelled node’s held lease when self-healing (never re-strands the replan)', async () => {
    // A bare status flip would leave the lease `held`, which the replan's N+1
    // scheduler reads as held forever (leases select by status alone).
    ctx.db
      .prepare("UPDATE approach_graph_revisions SET status = 'draining' WHERE id = ?")
      .run(ctx.revisionId);
    linkProcess(ctx, 120, 4656, NOW);
    insertNodeRun(ctx, 120, 'running', { processRunId: 120 });
    acquireLease(ctx.db, {
      graphRunId: ctx.graphRunId,
      ownerNodeRunId: 120,
      physicalDomain: 'dom',
      accessMode: 'exclusive',
      claimedPaths: null,
      now: NOW,
    });
    const result = await reconcileGraphRun(
      ctx.makeDeps({ facts: makeFacts({ alive: { 4656: false } }) }),
      { graphRunId: ctx.graphRunId },
    );
    expect(runRow(ctx).status).toBe('draining');
    expect(nodeRow(ctx, 120).status).toBe('cancelled');
    const lease = ctx.db
      .prepare('SELECT status FROM approach_resource_leases WHERE owner_node_run_id = ?')
      .get(120) as { status: string };
    expect(lease.status).toBe('released');
    expect(result.transitions).toBe(2);
  });

  it('clears a node on an OLDER draining revision when self-healing (two-drain shape)', async () => {
    // `replanQuiescenceBlockedBy` counts run-wide, so a node left active on an
    // older drain still blocks the replan. The self-heal must clear every
    // draining revision's abandoned nodes, not just the newest.
    ctx.db
      .prepare("UPDATE approach_graph_revisions SET status = 'draining' WHERE id = ?")
      .run(ctx.revisionId);
    ctx.db
      .prepare(
        `INSERT INTO approach_graph_revisions
           (graph_run_id, revision_number, canonical_graph, fingerprint, status, created_at)
         VALUES (?, 2, '{}', 'fp2', 'draining', ?)`,
      )
      .run(ctx.graphRunId, NOW);
    linkProcess(ctx, 121, 4757, NOW);
    insertNodeRun(ctx, 121, 'running', { processRunId: 121 }); // on the OLDER revision
    const result = await reconcileGraphRun(
      ctx.makeDeps({ facts: makeFacts({ alive: { 4757: false } }) }),
      { graphRunId: ctx.graphRunId },
    );
    expect(runRow(ctx).status).toBe('draining');
    expect(nodeRow(ctx, 121).status).toBe('cancelled');
    expect(
      countNodeRunsInStatusesForGraphRun(ctx.db, ctx.graphRunId, ACTIVE_NODE_STATUSES),
    ).toBe(0);
    expect(result.transitions).toBe(2);
  });

  it('clears a dead node on an already-draining run so the replan planner can allocate', async () => {
    // The normal post-election state: the run is ALREADY `draining`, so the
    // running-gated self-heal never fires and the node sweep can never reach the
    // dead `running` node. The draining branch must clear it, or the replan
    // launch is refused `not-quiescent` forever.
    ctx.db
      .prepare("UPDATE approach_graph_runs SET status = 'draining' WHERE id = ?")
      .run(ctx.graphRunId);
    ctx.db
      .prepare("UPDATE approach_graph_revisions SET status = 'draining' WHERE id = ?")
      .run(ctx.revisionId);
    linkProcess(ctx, 122, 4767, NOW);
    insertNodeRun(ctx, 122, 'running', { processRunId: 122 });
    const relaunched: number[] = [];
    const result = await reconcileGraphRun(
      ctx.makeDeps({
        facts: makeFacts({ alive: { 4767: false } }),
        relaunchReplanPlanner: (graphRunId) => relaunched.push(graphRunId),
      }),
      { graphRunId: ctx.graphRunId },
    );
    expect(runRow(ctx).status).toBe('draining');
    expect(nodeRow(ctx, 122).status).toBe('cancelled');
    expect(
      countNodeRunsInStatusesForGraphRun(ctx.db, ctx.graphRunId, ACTIVE_NODE_STATUSES),
    ).toBe(0);
    expect(relaunched).toEqual([ctx.graphRunId]);
    expect(result.transitions).toBe(1); // the node cancellation
  });

  it('refunds the cancelled node’s node-run budget when self-healing', async () => {
    // A cancelled visit produced no outcome, so its reservation must be released
    // — otherwise a near-ceiling graph refuses the replacement work.
    ctx.db
      .prepare("UPDATE approach_graph_revisions SET status = 'draining' WHERE id = ?")
      .run(ctx.revisionId);
    ctx.db
      .prepare('UPDATE approach_graph_runs SET node_run_count = 5 WHERE id = ?')
      .run(ctx.graphRunId);
    linkProcess(ctx, 123, 4777, NOW);
    insertNodeRun(ctx, 123, 'running', { processRunId: 123 });
    await reconcileGraphRun(
      ctx.makeDeps({ facts: makeFacts({ alive: { 4777: false } }) }),
      { graphRunId: ctx.graphRunId },
    );
    const run = ctx.db
      .prepare('SELECT node_run_count FROM approach_graph_runs WHERE id = ?')
      .get(ctx.graphRunId) as { node_run_count: number };
    expect(run.node_run_count).toBe(4);
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

  describe('a planning run whose bootstrap planner session is gone', () => {
    it('a running planner with a demonstrably dead process is marked stale and relaunched on the same run', async () => {
      toPlanning(ctx);
      insertPlannerRun(ctx, 201, 'running');
      linkPlannerProcess(ctx, 201, 201, 5555, NOW);
      const relaunched: number[] = [];
      const deps = ctx.makeDeps({
        facts: makeFacts({ alive: { 5555: false } }),
        relaunchPlanner: (graphRunId) => relaunched.push(graphRunId),
      });
      const result = await reconcileGraphRun(deps, { graphRunId: ctx.graphRunId });
      expect(plannerRow(ctx, 201).status).toBe('stale');
      expect(relaunched).toEqual([ctx.graphRunId]);
      // The run STAYS planning (not blocked) so the relaunched planner's later
      // submission is accepted by `acceptSubmittedPlan`.
      expect(runRow(ctx).status).toBe('planning');
      expect(result.transitions).toBe(1);
    });

    it('a running planner with a live attributable process is left alone (another window owns it)', async () => {
      toPlanning(ctx);
      insertPlannerRun(ctx, 202, 'running');
      linkPlannerProcess(ctx, 202, 202, 5656, NOW);
      const relaunched: number[] = [];
      const deps = ctx.makeDeps({
        facts: makeFacts({ alive: { 5656: true }, startMs: { 5656: Date.parse(NOW) } }),
        relaunchPlanner: (graphRunId) => relaunched.push(graphRunId),
      });
      const result = await reconcileGraphRun(deps, { graphRunId: ctx.graphRunId });
      expect(plannerRow(ctx, 202).status).toBe('running');
      expect(relaunched).toEqual([]);
      expect(runRow(ctx).status).toBe('planning');
      expect(result.transitions).toBe(0);
    });

    it('a running planner with no pid evidence is never declared dead', async () => {
      toPlanning(ctx);
      // No process_runs row at all.
      insertPlannerRun(ctx, 203, 'running');
      // A process_runs row whose pid is null is equally no evidence.
      insertPlannerRun(ctx, 204, 'running', { plannerRunNumber: 2 });
      linkPlannerProcess(ctx, 204, 204, null);
      const deps = ctx.makeDeps({
        relaunchPlanner: () => {
          throw new Error('must not relaunch without pid evidence');
        },
      });
      const result = await reconcileGraphRun(deps, { graphRunId: ctx.graphRunId });
      expect(plannerRow(ctx, 203).status).toBe('running');
      expect(plannerRow(ctx, 204).status).toBe('running');
      expect(runRow(ctx).status).toBe('planning');
      expect(result.transitions).toBe(0);
    });

    it('a launching planner with an owner nonce but no process proves a pre-spawn crash and relaunches', async () => {
      toPlanning(ctx);
      insertPlannerRun(ctx, 205, 'launching', { ownerNonce: 'nonce-1' });
      const relaunched: number[] = [];
      const deps = ctx.makeDeps({ relaunchPlanner: (graphRunId) => relaunched.push(graphRunId) });
      const result = await reconcileGraphRun(deps, { graphRunId: ctx.graphRunId });
      expect(plannerRow(ctx, 205).status).toBe('stale');
      expect(relaunched).toEqual([ctx.graphRunId]);
      expect(runRow(ctx).status).toBe('planning');
      expect(result.transitions).toBe(1);
    });

    it('a launching planner with a demonstrably dead process is marked stale and relaunched', async () => {
      toPlanning(ctx);
      insertPlannerRun(ctx, 206, 'launching');
      linkPlannerProcess(ctx, 206, 206, 5757, NOW);
      const relaunched: number[] = [];
      const deps = ctx.makeDeps({
        facts: makeFacts({ alive: { 5757: false } }),
        relaunchPlanner: (graphRunId) => relaunched.push(graphRunId),
      });
      const result = await reconcileGraphRun(deps, { graphRunId: ctx.graphRunId });
      expect(plannerRow(ctx, 206).status).toBe('stale');
      expect(relaunched).toEqual([ctx.graphRunId]);
      expect(runRow(ctx).status).toBe('planning');
      expect(result.transitions).toBe(1);
    });

    it('a launching planner with no nonce and no process is left alone (unprovable)', async () => {
      toPlanning(ctx);
      insertPlannerRun(ctx, 207, 'launching', { ownerNonce: null });
      const relaunched: number[] = [];
      const deps = ctx.makeDeps({ relaunchPlanner: (graphRunId) => relaunched.push(graphRunId) });
      const result = await reconcileGraphRun(deps, { graphRunId: ctx.graphRunId });
      expect(plannerRow(ctx, 207).status).toBe('launching');
      expect(relaunched).toEqual([]);
      expect(runRow(ctx).status).toBe('planning');
      expect(result.transitions).toBe(0);
    });

    it('a planning run with no bootstrap planner run is a no-op', async () => {
      toPlanning(ctx);
      const result = await reconcileGraphRun(ctx.makeDeps(), { graphRunId: ctx.graphRunId });
      expect(runRow(ctx).status).toBe('planning');
      expect(result.transitions).toBe(0);
    });

    it('relaunches AFTER the stale transition commits — never inside its transaction', async () => {
      // The host binding of `relaunchPlanner` opens its own BEGIN IMMEDIATE
      // transaction (`relaunchBootstrapPlanner` → `relaunchBootstrapPlannerRun`).
      // If reconcile called it INSIDE the stale-marking transaction, the nested
      // `BEGIN` on the same connection would throw. `withImmediate` (better-
      // sqlite3's `transaction`) throws on exactly that, so a callback that
      // opens its own transaction proves the ordering.
      toPlanning(ctx);
      insertPlannerRun(ctx, 208, 'running');
      linkPlannerProcess(ctx, 208, 208, 5858, NOW);
      let insideTransaction = true;
      const deps = ctx.makeDeps({
        facts: makeFacts({ alive: { 5858: false } }),
        relaunchPlanner: (graphRunId) => {
          // Open the same kind of transaction the real host launch opens.
          withImmediate(ctx.db, () => {
            ctx.db.prepare('SELECT 1 FROM approach_graph_runs WHERE id = ?').get(graphRunId);
          });
          insideTransaction = false;
        },
      });
      const result = await reconcileGraphRun(deps, { graphRunId: ctx.graphRunId });
      expect(plannerRow(ctx, 208).status).toBe('stale');
      expect(insideTransaction).toBe(false);
      expect(result.transitions).toBe(1);
    });
  });

  describe('a planning run whose bootstrap planner is BLOCKED awaiting its compile re-prompt', () => {
    it('a blocked planner with attempts remaining and no live process is handed to the compile-repair relaunch', async () => {
      toPlanning(ctx);
      insertPlannerRun(ctx, 220, 'blocked');
      ctx.db.prepare('UPDATE approach_planner_runs SET compile_attempt = 1 WHERE id = ?').run(220);
      const relaunched: { graphRunId: number; plannerRunId: number; attempt: number }[] = [];
      const deps = ctx.makeDeps({
        relaunchCompileRepair: (graphRunId, plannerRunId, attempt) =>
          relaunched.push({ graphRunId, plannerRunId, attempt }),
      });
      const result = await reconcileGraphRun(deps, { graphRunId: ctx.graphRunId });
      expect(relaunched).toEqual([{ graphRunId: ctx.graphRunId, plannerRunId: 220, attempt: 1 }]);
      expect(plannerRow(ctx, 220).status).toBe('blocked');
      expect(runRow(ctx).status).toBe('planning');
      expect(result.transitions).toBe(0);
    });

    it('H1: a DRAINING run whose replan planner is blocked awaiting its re-prompt is handed the same relaunch', async () => {
      toDraining(ctx);
      insertPlannerRun(ctx, 230, 'blocked', { kind: 'replan', plannerRunNumber: 2 });
      ctx.db.prepare('UPDATE approach_planner_runs SET compile_attempt = 1 WHERE id = ?').run(230);
      const relaunched: { graphRunId: number; plannerRunId: number; attempt: number }[] = [];
      const deps = ctx.makeDeps({
        relaunchCompileRepair: (graphRunId, plannerRunId, attempt) =>
          relaunched.push({ graphRunId, plannerRunId, attempt }),
      });
      const result = await reconcileGraphRun(deps, { graphRunId: ctx.graphRunId });
      expect(relaunched).toEqual([{ graphRunId: ctx.graphRunId, plannerRunId: 230, attempt: 1 }]);
      expect(runRow(ctx).status).toBe('draining');
      expect(result.transitions).toBe(0);
    });

    it('a blocked planner already exhausted (compile_attempt >= MAX) is never re-prompted', async () => {
      toPlanning(ctx);
      insertPlannerRun(ctx, 221, 'blocked');
      ctx.db.prepare('UPDATE approach_planner_runs SET compile_attempt = 3 WHERE id = ?').run(221);
      const deps = ctx.makeDeps({
        relaunchCompileRepair: () => {
          throw new Error('must not relaunch an exhausted planner');
        },
      });
      const result = await reconcileGraphRun(deps, { graphRunId: ctx.graphRunId });
      expect(plannerRow(ctx, 221).status).toBe('blocked');
      expect(result.transitions).toBe(0);
    });

    it('a blocked planner whose window still holds a live session is left alone', async () => {
      toPlanning(ctx);
      insertPlannerRun(ctx, 222, 'blocked');
      const deps = ctx.makeDeps({
        sessionFor: (id) => (id === 222 ? { pid: 1234 } : undefined),
        relaunchCompileRepair: () => {
          throw new Error('must not relaunch while this window owns a live session');
        },
      });
      const result = await reconcileGraphRun(deps, { graphRunId: ctx.graphRunId });
      expect(plannerRow(ctx, 222).status).toBe('blocked');
      expect(result.transitions).toBe(0);
    });

    it('a blocked planner with a live attributable process (another window mid-relaunch) is left alone', async () => {
      toPlanning(ctx);
      insertPlannerRun(ctx, 223, 'blocked');
      linkPlannerProcess(ctx, 223, 223, 9090, NOW);
      const deps = ctx.makeDeps({
        facts: makeFacts({ alive: { 9090: true }, startMs: { 9090: Date.parse(NOW) } }),
        relaunchCompileRepair: () => {
          throw new Error('must not relaunch over a live attributable process');
        },
      });
      const result = await reconcileGraphRun(deps, { graphRunId: ctx.graphRunId });
      expect(plannerRow(ctx, 223).status).toBe('blocked');
      expect(result.transitions).toBe(0);
    });

    it('H1: an EXHAUSTED blocked replan planner is never re-prompted either', async () => {
      toDraining(ctx);
      insertPlannerRun(ctx, 224, 'blocked', { kind: 'replan' });
      ctx.db.prepare('UPDATE approach_planner_runs SET compile_attempt = 3 WHERE id = ?').run(224);
      const deps = ctx.makeDeps({
        relaunchCompileRepair: () => {
          throw new Error('must not relaunch an exhausted replan planner');
        },
      });
      const result = await reconcileGraphRun(deps, { graphRunId: ctx.graphRunId });
      expect(plannerRow(ctx, 224).status).toBe('blocked');
      expect(result.transitions).toBe(0);
    });
  });

  describe('a draining run whose replan planner session is gone', () => {
    it('a running replan planner with a demonstrably dead process is marked stale and relaunched on the same draining run', async () => {
      toDraining(ctx);
      insertPlannerRun(ctx, 401, 'running', { kind: 'replan' });
      linkPlannerProcess(ctx, 401, 401, 7171, NOW);
      const relaunched: number[] = [];
      const deps = ctx.makeDeps({
        facts: makeFacts({ alive: { 7171: false } }),
        relaunchReplanPlanner: (graphRunId) => relaunched.push(graphRunId),
      });
      const result = await reconcileGraphRun(deps, { graphRunId: ctx.graphRunId });
      expect(plannerRow(ctx, 401).status).toBe('stale');
      expect(relaunched).toEqual([ctx.graphRunId]);
      // The run STAYS draining: `draining` has no `blocked` edge, and the
      // fresh replan planner's submission is only accepted while it drains.
      expect(runRow(ctx).status).toBe('draining');
      expect(result.transitions).toBe(1);
    });

    it('a launching replan planner with an owner nonce and no process proves a pre-spawn crash and relaunches', async () => {
      toDraining(ctx);
      insertPlannerRun(ctx, 402, 'launching', { kind: 'replan', ownerNonce: 'nonce-r1' });
      const relaunched: number[] = [];
      const deps = ctx.makeDeps({
        relaunchReplanPlanner: (graphRunId) => relaunched.push(graphRunId),
      });
      const result = await reconcileGraphRun(deps, { graphRunId: ctx.graphRunId });
      expect(plannerRow(ctx, 402).status).toBe('stale');
      expect(relaunched).toEqual([ctx.graphRunId]);
      expect(runRow(ctx).status).toBe('draining');
      expect(result.transitions).toBe(1);
    });

    it('a running replan planner with no pid evidence is never declared dead', async () => {
      toDraining(ctx);
      insertPlannerRun(ctx, 403, 'running', { kind: 'replan' });
      const deps = ctx.makeDeps({
        relaunchReplanPlanner: () => {
          throw new Error('must not relaunch without pid evidence');
        },
      });
      const result = await reconcileGraphRun(deps, { graphRunId: ctx.graphRunId });
      expect(plannerRow(ctx, 403).status).toBe('running');
      expect(runRow(ctx).status).toBe('draining');
      expect(result.transitions).toBe(0);
    });

    it('a running replan planner with a live attributable process is left alone (another window owns it)', async () => {
      toDraining(ctx);
      insertPlannerRun(ctx, 404, 'running', { kind: 'replan' });
      linkPlannerProcess(ctx, 404, 404, 7272, NOW);
      const relaunched: number[] = [];
      const deps = ctx.makeDeps({
        facts: makeFacts({ alive: { 7272: true }, startMs: { 7272: Date.parse(NOW) } }),
        relaunchReplanPlanner: (graphRunId) => relaunched.push(graphRunId),
      });
      const result = await reconcileGraphRun(deps, { graphRunId: ctx.graphRunId });
      expect(plannerRow(ctx, 404).status).toBe('running');
      expect(relaunched).toEqual([]);
      expect(result.transitions).toBe(0);
    });

    it('a launching replan planner with no nonce and no process is left alone (unprovable)', async () => {
      toDraining(ctx);
      insertPlannerRun(ctx, 405, 'launching', { kind: 'replan', ownerNonce: null });
      const relaunched: number[] = [];
      const deps = ctx.makeDeps({
        relaunchReplanPlanner: (graphRunId) => relaunched.push(graphRunId),
      });
      const result = await reconcileGraphRun(deps, { graphRunId: ctx.graphRunId });
      expect(plannerRow(ctx, 405).status).toBe('launching');
      expect(relaunched).toEqual([]);
      expect(result.transitions).toBe(0);
    });

    it('a replan planner this window still holds a session for is left alone', async () => {
      toDraining(ctx);
      insertPlannerRun(ctx, 406, 'running', { kind: 'replan' });
      linkPlannerProcess(ctx, 406, 406, 7373, NOW);
      const relaunched: number[] = [];
      const deps = ctx.makeDeps({
        facts: makeFacts({ alive: { 7373: false } }),
        sessionFor: () => ({ pid: 7373 }),
        relaunchReplanPlanner: (graphRunId) => relaunched.push(graphRunId),
      });
      const result = await reconcileGraphRun(deps, { graphRunId: ctx.graphRunId });
      expect(plannerRow(ctx, 406).status).toBe('running');
      expect(relaunched).toEqual([]);
      expect(result.transitions).toBe(0);
    });

    it('judges only the NEWEST replan planner — a superseded stale one never relaunches', async () => {
      toDraining(ctx);
      insertPlannerRun(ctx, 407, 'stale', { kind: 'replan', plannerRunNumber: 2 });
      insertPlannerRun(ctx, 408, 'running', { kind: 'replan', plannerRunNumber: 3 });
      linkPlannerProcess(ctx, 408, 408, 7474, NOW);
      const relaunched: number[] = [];
      const deps = ctx.makeDeps({
        facts: makeFacts({ alive: { 7474: true }, startMs: { 7474: Date.parse(NOW) } }),
        relaunchReplanPlanner: (graphRunId) => relaunched.push(graphRunId),
      });
      const result = await reconcileGraphRun(deps, { graphRunId: ctx.graphRunId });
      expect(relaunched).toEqual([]);
      expect(result.transitions).toBe(0);
    });

    it('a mid-replan drain with no replan planner launches one but never touches the bootstrap planner', async () => {
      toDraining(ctx);
      insertPlannerRun(ctx, 409, 'submitted', { kind: 'bootstrap' });
      linkPlannerProcess(ctx, 409, 409, 7575, NOW);
      const relaunched: number[] = [];
      const deps = ctx.makeDeps({
        facts: makeFacts({ alive: { 7575: false } }),
        relaunchReplanPlanner: (graphRunId) => relaunched.push(graphRunId),
        relaunchPlanner: () => {
          throw new Error('must not relaunch the bootstrap planner of a draining run');
        },
      });
      const result = await reconcileGraphRun(deps, { graphRunId: ctx.graphRunId });
      // The submitted bootstrap planner is left alone; a fresh REPLAN planner
      // is what the drained revision is waiting for.
      expect(plannerRow(ctx, 409).status).toBe('submitted');
      expect(relaunched).toEqual([ctx.graphRunId]);
      // The dispatch itself is not a durable transition here (the host owns
      // the allocation), so the count stays honest.
      expect(result.transitions).toBe(0);
    });

    it('a STOP-drained run (revision still active) launches no planner — it waits for a deliberate Restart', async () => {
      ctx.db
        .prepare("UPDATE approach_graph_runs SET status = 'draining' WHERE id = ?")
        .run(ctx.graphRunId);
      // The revision stays `active`: Stop never touches it. No election ran, so
      // reconcile must not auto-launch a replan planner and defeat H2.
      const relaunched: number[] = [];
      const deps = ctx.makeDeps({ relaunchReplanPlanner: (graphRunId) => relaunched.push(graphRunId) });
      const result = await reconcileGraphRun(deps, { graphRunId: ctx.graphRunId });
      expect(relaunched).toEqual([]);
      expect(runRow(ctx).status).toBe('draining');
      expect(result.transitions).toBe(0);
    });

    it('a STOP-drained run leaves a leftover prior-drain planner strictly alone', async () => {
      // A genuine Stop drain (revision active) may still carry a prior drain's
      // replan planner. The whole crash matrix must skip it: no compile repair,
      // no stale, no relaunch.
      ctx.db
        .prepare("UPDATE approach_graph_runs SET status = 'draining' WHERE id = ?")
        .run(ctx.graphRunId);
      insertPlannerRun(ctx, 4101, 'blocked', { kind: 'replan', plannerRunNumber: 2 });
      insertPlannerRun(ctx, 4102, 'running', { kind: 'replan', plannerRunNumber: 3 });
      linkPlannerProcess(ctx, 4102, 4102, 7002, NOW);
      insertPlannerRun(ctx, 4103, 'ready', { kind: 'replan', plannerRunNumber: 4 });
      const relaunched: number[] = [];
      const repaired: number[] = [];
      const deps = ctx.makeDeps({
        relaunchReplanPlanner: (graphRunId) => relaunched.push(graphRunId),
        relaunchCompileRepair: (graphRunId, plannerRunId) => {
          repaired.push(plannerRunId);
        },
        facts: makeFacts({ alive: { 7002: false } }),
      });
      const result = await reconcileGraphRun(deps, { graphRunId: ctx.graphRunId });
      expect(relaunched).toEqual([]);
      expect(repaired).toEqual([]);
      expect(plannerRow(ctx, 4101).status).toBe('blocked');
      expect(plannerRow(ctx, 4102).status).toBe('running');
      expect(plannerRow(ctx, 4103).status).toBe('ready');
      expect(result.transitions).toBe(0);
    });

    it('relaunches AFTER the stale transition commits — never inside its transaction', async () => {
      toDraining(ctx);
      insertPlannerRun(ctx, 410, 'running', { kind: 'replan' });
      linkPlannerProcess(ctx, 410, 410, 7676, NOW);
      let insideTransaction = true;
      const deps = ctx.makeDeps({
        facts: makeFacts({ alive: { 7676: false } }),
        relaunchReplanPlanner: (graphRunId) => {
          withImmediate(ctx.db, () => {
            ctx.db.prepare('SELECT 1 FROM approach_graph_runs WHERE id = ?').get(graphRunId);
          });
          insideTransaction = false;
        },
      });
      const result = await reconcileGraphRun(deps, { graphRunId: ctx.graphRunId });
      expect(plannerRow(ctx, 410).status).toBe('stale');
      expect(insideTransaction).toBe(false);
      expect(result.transitions).toBe(1);
    });

    it('a draining run whose ticket left impl is still cancelled before any planner judgement', async () => {
      toDraining(ctx);
      insertPlannerRun(ctx, 411, 'running', { kind: 'replan' });
      linkPlannerProcess(ctx, 411, 411, 7777, NOW);
      ctx.db.prepare("UPDATE tickets SET stage_current = 'uat' WHERE id = ?").run(ctx.ticketId);
      const relaunched: number[] = [];
      const deps = ctx.makeDeps({
        facts: makeFacts({ alive: { 7777: false } }),
        relaunchReplanPlanner: (graphRunId) => relaunched.push(graphRunId),
      });
      await reconcileGraphRun(deps, { graphRunId: ctx.graphRunId });
      expect(runRow(ctx).status).toBe('cancelled');
      expect(relaunched).toEqual([]);
    });
  });

  it('an accepted plan awaiting confirmation stays passive after its submitted planner exits', async () => {
    ctx.db
      .prepare("UPDATE approach_graph_runs SET status = 'awaiting-confirmation' WHERE id = ?")
      .run(ctx.graphRunId);
    insertPlannerRun(ctx, 302, 'submitted');
    linkPlannerProcess(ctx, 302, 302, 6464, NOW);
    const result = await reconcileGraphRun(
      ctx.makeDeps({ facts: makeFacts({ alive: { 6464: false } }) }),
      { graphRunId: ctx.graphRunId },
    );
    expect(runRow(ctx)).toEqual({ status: 'awaiting-confirmation', blocked_reason: null });
    expect(result.transitions).toBe(0);
  });

  describe('a draining run with ZERO replan planner rows (the election→launch gap)', () => {
    /** A parseable document so `electReplan` can run its active-revision check
     *  (the default harness revision is `'{}'`, unparseable). */
    const ELECTION_DOC = JSON.stringify({
      version: 1,
      title: 't',
      rationaleArtifact: 'r',
      entries: ['a'],
      artifacts: [],
      nodes: [
        {
          id: 'a',
          kind: 'agent',
          label: 'a',
          profile: 'default',
          instructionsArtifact: 'i',
          inputs: [],
          outputs: [],
          resources: { reads: [], writes: [] },
          outcomes: ['complete', 'blocked', 'replan'],
          budget: { maxVisits: 1 },
        },
      ],
      edges: [{ id: 'e-a-end', from: 'a', on: 'complete', to: 'END' }],
      budgets: { maxNodeRuns: 10, maxExpertRuns: 1, maxReplans: 2 },
    });

    it('launches a replan planner when the election committed but no planner row exists', async () => {
      // The gap: `electReplan` commits the drain in its own transaction and
      // nothing ever allocates the planner run. Reconcile must launch one.
      ctx.db
        .prepare('UPDATE approach_graph_revisions SET canonical_graph = ? WHERE id = ?')
        .run(ELECTION_DOC, ctx.revisionId);
      const elected = electReplan(
        { db: ctx.db, transaction: <T>(fn: () => T): T => withImmediate(ctx.db, fn), now: () => NOW },
        { graphRunId: ctx.graphRunId },
      );
      expect(elected).toEqual({ elected: true });
      const replanPlanners = ctx.db
        .prepare("SELECT COUNT(*) AS n FROM approach_planner_runs WHERE kind = 'replan'")
        .get() as { n: number };
      expect(replanPlanners.n).toBe(0);

      const relaunched: number[] = [];
      await reconcileGraphRun(
        ctx.makeDeps({ relaunchReplanPlanner: (graphRunId) => relaunched.push(graphRunId) }),
        { graphRunId: ctx.graphRunId },
      );
      expect(relaunched).toEqual([ctx.graphRunId]);
      expect(runRow(ctx).status).toBe('draining');
    });

    it('launches for a draining run parked by any route, not just an election', async () => {
      toDraining(ctx);
      const relaunched: number[] = [];
      const result = await reconcileGraphRun(
        ctx.makeDeps({ relaunchReplanPlanner: (graphRunId) => relaunched.push(graphRunId) }),
        { graphRunId: ctx.graphRunId },
      );
      expect(relaunched).toEqual([ctx.graphRunId]);
      expect(runRow(ctx).status).toBe('draining');
      expect(result.transitions).toBe(0);
    });

    it('a run that replanned BEFORE is not judged against the prior drain\u2019s planner', async () => {
      // The prior drain produced revision 2: its replan planner P1 is
      // `submitted` and bound to target revision 2. The run is now on
      // revision 2, draining for a SECOND replan (target revision 3). P1 must
      // NOT satisfy the current drain, or the run strands forever.
      ctx.db
        .prepare("UPDATE approach_graph_runs SET status = 'draining' WHERE id = ?")
        .run(ctx.graphRunId);
      ctx.db
        .prepare(
          "UPDATE approach_graph_revisions SET revision_number = 2, status = 'draining' WHERE id = ?",
        )
        .run(ctx.revisionId);
      ctx.db
        .prepare(
          `INSERT INTO approach_planner_runs
             (graph_run_id, planner_run_number, kind, status, target_revision_number)
           VALUES (?, 2, 'replan', 'submitted', 2)`,
        )
        .run(ctx.graphRunId);
      const relaunched: number[] = [];
      const result = await reconcileGraphRun(
        ctx.makeDeps({ relaunchReplanPlanner: (graphRunId) => relaunched.push(graphRunId) }),
        { graphRunId: ctx.graphRunId },
      );
      expect(relaunched).toEqual([ctx.graphRunId]);
      expect(runRow(ctx).status).toBe('draining');
      expect(result.transitions).toBe(0);
    });

    it('adopts a still-live LEGACY NULL-target planner instead of launching a duplicate', async () => {
      // Upgrade: a replan planner allocated before targets existed is still
      // running. Ignoring it would spawn a second planner for the same drain
      // (duplicate agent spend); it must be adopted and judged as-is.
      toDraining(ctx);
      insertPlannerRun(ctx, 501, 'running', {
        kind: 'replan',
        targetRevisionNumber: null,
      });
      linkPlannerProcess(ctx, 9501, 501, 7001, NOW);
      const relaunched: number[] = [];
      const result = await reconcileGraphRun(
        ctx.makeDeps({
          facts: makeFacts({ alive: { 7001: true } }),
          relaunchReplanPlanner: (graphRunId) => relaunched.push(graphRunId),
        }),
        { graphRunId: ctx.graphRunId },
      );
      expect(relaunched).toEqual([]);
      expect(result.transitions).toBe(0);
    });

    it('ignores an already-SUBMITTED legacy NULL-target planner and launches for this drain', async () => {
      // A legacy submitted plan belongs to the earlier drain that produced the
      // revision now draining; it must not satisfy the current drain.
      toDraining(ctx);
      insertPlannerRun(ctx, 502, 'submitted', {
        kind: 'replan',
        targetRevisionNumber: null,
      });
      const relaunched: number[] = [];
      const result = await reconcileGraphRun(
        ctx.makeDeps({ relaunchReplanPlanner: (graphRunId) => relaunched.push(graphRunId) }),
        { graphRunId: ctx.graphRunId },
      );
      expect(relaunched).toEqual([ctx.graphRunId]);
      expect(runRow(ctx).status).toBe('draining');
      expect(result.transitions).toBe(0);
    });

    it('ignores an ABANDONED legacy NULL-target planner and launches for this drain', async () => {
      // An abandoned (stale) legacy row belongs to no live drain; it must not
      // satisfy (or block) the current one — otherwise the run strands.
      toDraining(ctx);
      insertPlannerRun(ctx, 502, 'stale', { kind: 'replan', targetRevisionNumber: null });
      const relaunched: number[] = [];
      const result = await reconcileGraphRun(
        ctx.makeDeps({ relaunchReplanPlanner: (graphRunId) => relaunched.push(graphRunId) }),
        { graphRunId: ctx.graphRunId },
      );
      expect(relaunched).toEqual([ctx.graphRunId]);
      expect(runRow(ctx).status).toBe('draining');
      expect(result.transitions).toBe(0);
    });

    it('stales and relaunches a planner left `ready` (allocated but never launched)', async () => {
      // The single-flight gate would otherwise treat the `ready` row as a live
      // owner forever, and the crash matrix never drove `ready`.
      toDraining(ctx);
      insertPlannerRun(ctx, 503, 'ready', { kind: 'replan' });
      const relaunched: number[] = [];
      const result = await reconcileGraphRun(
        ctx.makeDeps({ relaunchReplanPlanner: (graphRunId) => relaunched.push(graphRunId) }),
        { graphRunId: ctx.graphRunId },
      );
      expect(plannerRow(ctx, 503).status).toBe('stale');
      expect(relaunched).toEqual([ctx.graphRunId]);
      expect(result.transitions).toBe(1);
    });

    it('bounds the `ready` relaunch: after the cap it parks the run blocked (a reachable exit)', async () => {
      // A launch that keeps failing before `ready → launching` (e.g. no launch
      // worktree) must not stream a new planner row every sweep, and must not
      // leave a `ready` row that blocks single-flight and Restart forever.
      toDraining(ctx);
      insertPlannerRun(ctx, 601, 'stale', { kind: 'replan', plannerRunNumber: 2 });
      insertPlannerRun(ctx, 602, 'stale', { kind: 'replan', plannerRunNumber: 3 });
      insertPlannerRun(ctx, 603, 'stale', { kind: 'replan', plannerRunNumber: 4 });
      insertPlannerRun(ctx, 604, 'ready', { kind: 'replan', plannerRunNumber: 5 });
      const relaunched: number[] = [];
      const result = await reconcileGraphRun(
        ctx.makeDeps({ relaunchReplanPlanner: (graphRunId) => relaunched.push(graphRunId) }),
        { graphRunId: ctx.graphRunId },
      );
      expect(relaunched).toEqual([]);
      expect(plannerRow(ctx, 604).status).toBe('stale');
      expect(runRow(ctx)).toMatchObject({ status: 'blocked' });
      expect(result.transitions).toBe(1);
    });

    it('leaves a bootstrap planner left `ready` strictly alone (not this sweep\u2019s retry)', async () => {
      const ctx = harness();
      ctx.db
        .prepare("UPDATE approach_graph_runs SET status = 'planning' WHERE id = ?")
        .run(ctx.graphRunId);
      insertPlannerRun(ctx, 701, 'ready', { kind: 'bootstrap', plannerRunNumber: 1 });
      const relaunched: number[] = [];
      const result = await reconcileGraphRun(
        ctx.makeDeps({ relaunchPlanner: (graphRunId) => relaunched.push(graphRunId) }),
        { graphRunId: ctx.graphRunId },
      );
      expect(relaunched).toEqual([]);
      expect(plannerRow(ctx, 701).status).toBe('ready');
      expect(result.transitions).toBe(0);
    });

    it('does NOT launch over a planner bound to THIS drain that is still working', async () => {
      // A submitted planner whose target IS this drain (revision 2) is awaiting
      // acceptance — launching a second planner would be duplicate spend.
      toDraining(ctx); // revision 1 -> target revision 2
      ctx.db
        .prepare(
          `INSERT INTO approach_planner_runs
             (graph_run_id, planner_run_number, kind, status, target_revision_number)
           VALUES (?, 2, 'replan', 'submitted', 2)`,
        )
        .run(ctx.graphRunId);
      const relaunched: number[] = [];
      const result = await reconcileGraphRun(
        ctx.makeDeps({ relaunchReplanPlanner: (graphRunId) => relaunched.push(graphRunId) }),
        { graphRunId: ctx.graphRunId },
      );
      expect(relaunched).toEqual([]);
      expect(result.transitions).toBe(0);
    });
  });
});
