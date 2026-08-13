/**
 * Replan election and drain (Slice 4 Task 5).
 *
 * The ten immutable-replanning steps, pinned host-agnostic:
 *
 *  - `electReplan` is the single-winner election: one transaction, a
 *    conditional `active → draining` on the revision AND `running → draining`
 *    on the run, with the accepted replan counter incremented only by the
 *    winner. A raced second window reads the moved run and is the no-op
 *    `{elected:false, reason:'draining'}`. A later replan request while
 *    draining is persisted as the requesting node's own bounded row and
 *    launches no planner. Reaching the document's `budgets.maxReplans`
 *    REFUSES: the node's effective outcome becomes `blocked` with reason
 *    `graph-budget-exhausted`, the run blocks, and no election is attempted.
 *
 *  - `beginReplanPlannerRun` (steps 5–7) allocates exactly one replan
 *    `PlannerRun` with the next monotonic counter, and only once the drain
 *    quiesces (no active node runs, no ambiguous lease). It cancels the
 *    revision's pending activations, snapshots the prompt, and writes the
 *    elected + secondary replan reasons as a FILE ARTIFACT through the
 *    injected `writeSnapshot` — never argv — producing the launch request.
 *
 *  - `submitReplanDocument` (steps 8–10) validates the new document, defers
 *    (never fails) nodes whose claims overlap a still-`held` lease from the
 *    draining revision, persists revision N+1 with `supersedes_revision_id`,
 *    supersedes N without rewriting history, and resumes scheduling. A
 *    submission whose revision is no longer draining is the idempotent no-op:
 *    the late planner run is marked `stale`, no revision is created.
 */

import { describe, it, expect, vi } from 'vitest';
import { openStore } from '../../../store/db.js';
import {
  electReplan,
  beginReplanPlannerRun,
  submitReplanDocument,
  type ReplanDeps,
  type ReplanLaunchDeps,
  type SubmitReplanDeps,
} from './replan.js';
import type { GraphDocument, ApproachNode } from '../parse.js';
import type { CompiledGraph } from '../compile.js';

interface Ctx {
  db: ReturnType<typeof openStore>['db'];
  graphRunId: number;
  revisionId: number;
  ticketId: number;
  now: string;
  makeDeps: (overrides?: Partial<ReplanDeps>) => ReplanDeps;
}

const GRAPH_N = (maxReplans: number): GraphDocument => ({
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
    {
      id: 'b',
      kind: 'agent',
      label: 'b',
      profile: 'default',
      instructionsArtifact: 'i',
      inputs: [],
      outputs: [],
      resources: { reads: [], writes: [] },
      outcomes: ['complete'],
      budget: { maxVisits: 1 },
    },
  ],
  edges: [
    { id: 'e-a-end', from: 'a', on: 'complete', to: 'END' },
    { id: 'e-b-end', from: 'b', on: 'complete', to: 'END' },
  ],
  budgets: { maxNodeRuns: 10, maxExpertRuns: 1, maxReplans },
});

function harness(maxReplans = 1, runStatus = 'running', replanCount = 0): Ctx {
  const store = openStore(':memory:');
  const db = store.db;
  db.pragma('busy_timeout = 0');
  const ticketId = Number(
    db.prepare("INSERT INTO tickets (key) VALUES ('T-1')").run().lastInsertRowid,
  );
  const graphRunId = Number(
    db
      .prepare(
        `INSERT INTO approach_graph_runs (ticket_id, stage_key, stage_attempt, approach_id, status, replan_count, created_at)
         VALUES (?, 'impl', 0, 'x', ?, ?, '2026-08-12T00:00:00.000Z')`,
      )
      .run(ticketId, runStatus, replanCount)
      .lastInsertRowid,
  );
  const revisionId = Number(
    db
      .prepare(
        `INSERT INTO approach_graph_revisions
           (graph_run_id, revision_number, canonical_graph, fingerprint, status, created_at)
         VALUES (?, 1, ?, 'fp-N', 'active', '2026-08-12T00:00:00.000Z')`,
      )
      .run(graphRunId, JSON.stringify(GRAPH_N(maxReplans)))
      .lastInsertRowid,
  );
  const now = '2026-08-12T00:00:00.000Z';
  const base: ReplanDeps = {
    db,
    transaction: <T>(fn: () => T): T =>
      (db.transaction as unknown as (f: () => T, o: { begin: 'immediate' }) => () => T)(
        fn,
        { begin: 'immediate' },
      )(),
    now: () => now,
  };
  return {
    db,
    graphRunId,
    revisionId,
    ticketId,
    now,
    makeDeps: (overrides) => ({ ...base, ...overrides }),
  };
}

function setRunStatus(ctx: Ctx, status: string): void {
  ctx.db.prepare('UPDATE approach_graph_runs SET status = ? WHERE id = ?').run(status, ctx.graphRunId);
}

function setRevisionStatus(ctx: Ctx, revisionId: number, status: string): void {
  ctx.db
    .prepare('UPDATE approach_graph_revisions SET status = ? WHERE id = ?')
    .run(status, revisionId);
}

function nodeRun(ctx: Ctx, id: number, nodeId: string, status = 'completed'): void {
  ctx.db
    .prepare(
      `INSERT INTO approach_node_runs
         (id, graph_run_id, revision_id, node_id, node_kind, visit_number, status)
       VALUES (?, ?, ?, ?, 'agent', 1, ?)`,
    )
    .run(id, ctx.graphRunId, ctx.revisionId, nodeId, status);
}

function claimToken(ctx: Ctx, nodeRunId: number, edgeId: string): void {
  ctx.db
    .prepare(
      `INSERT INTO approach_graph_tokens
         (revision_id, source_node_run_id, is_entry, edge_id, destination_node_id,
          destination_end, fork_instance, fork_lineage, status, created_at)
       VALUES (?, NULL, 1, ?, 'a', 0, 0, 'root', 'claimed', '2026-08-12T00:00:00.000Z')`,
    )
    .run(ctx.revisionId, edgeId);
  ctx.db
    .prepare('UPDATE approach_graph_tokens SET claiming_node_run_id = ? WHERE edge_id = ?')
    .run(nodeRunId, edgeId);
}

function plannerRun(
  ctx: Ctx,
  id: number,
  number: number,
  status: string,
  extra?: { kind?: 'bootstrap' | 'replan'; graphSnapshotId?: string },
): void {
  ctx.db
    .prepare(
      `INSERT INTO approach_planner_runs
         (id, graph_run_id, planner_run_number, kind, status, graph_snapshot_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      ctx.graphRunId,
      number,
      extra?.kind ?? 'replan',
      status,
      extra?.graphSnapshotId ?? null,
    );
}

function tokenCount(ctx: Ctx, status: string): number {
  const row = ctx.db
    .prepare('SELECT COUNT(*) AS n FROM approach_graph_tokens WHERE status = ?')
    .get(status) as { n: number };
  return row.n;
}

function revisionCount(ctx: Ctx): number {
  const row = ctx.db
    .prepare('SELECT COUNT(*) AS n FROM approach_graph_revisions WHERE graph_run_id = ?')
    .get(ctx.graphRunId) as { n: number };
  return row.n;
}

function runRow(ctx: Ctx): { status: string; blocked_reason: string | null; replan_count: number } {
  return ctx.db
    .prepare('SELECT status, blocked_reason, replan_count FROM approach_graph_runs WHERE id = ?')
    .get(ctx.graphRunId) as never;
}

function nodeRow(
  ctx: Ctx,
  id: number,
): { status: string; outcome: string | null; effective_outcome: string | null; reason: string | null; failure_category: string | null } {
  return ctx.db
    .prepare(
      'SELECT status, outcome, effective_outcome, reason, failure_category FROM approach_node_runs WHERE id = ?',
    )
    .get(id) as never;
}

function draftN1(): GraphDocument {
  return {
    version: 1,
    title: 't2',
    rationaleArtifact: 'r',
    entries: ['b'],
    artifacts: [],
    nodes: [
      {
        id: 'b',
        kind: 'agent',
        label: 'b',
        profile: 'default',
        instructionsArtifact: 'i',
        inputs: [],
        outputs: [],
        resources: { reads: [], writes: [] },
        outcomes: ['complete'],
        budget: { maxVisits: 1 },
      },
    ],
    edges: [{ id: 'e-b-end', from: 'b', on: 'complete', to: 'END' }],
    budgets: { maxNodeRuns: 10, maxExpertRuns: 1, maxReplans: 1 },
  };
}

function compileOk(document: GraphDocument): { ok: true; compiled: CompiledGraph } {
  const canonicalJson = JSON.stringify(document);
  return {
    ok: true,
    compiled: {
      document,
      canonicalJson,
      fingerprint: 'fp-N1',
      commandFingerprints: {},
      outgoing: {},
      incoming: {},
      overlaps: [],
      warnings: [],
    },
  };
}

function submitDeps(
  ctx: Ctx,
  overrides?: Partial<SubmitReplanDeps>,
): SubmitReplanDeps {
  return {
    ...ctx.makeDeps(),
    compileDocument: (document) => compileOk(document),
    physicalDomainsOf: () => [],
    ...overrides,
  };
}

describe('electReplan — the single-winner election (step 1)', () => {
  it('two concurrent elections elect exactly one initiator; the loser is a no-op', () => {
    const ctx = harness(1);
    const first = electReplan(ctx.makeDeps(), { graphRunId: ctx.graphRunId });
    expect(first).toEqual({ elected: true });
    expect(runRow(ctx)).toMatchObject({ status: 'draining', replan_count: 1 });
    const revision = ctx.db
      .prepare('SELECT status FROM approach_graph_revisions WHERE id = ?')
      .get(ctx.revisionId) as { status: string };
    expect(revision.status).toBe('draining');

    const second = electReplan(ctx.makeDeps(), { graphRunId: ctx.graphRunId });
    expect(second).toEqual({ elected: false, reason: 'draining' });
    expect(runRow(ctx)).toMatchObject({ status: 'draining', replan_count: 1 });
  });

  it('is a no-op for a run that is not running', () => {
    const ctx = harness(1, 'blocked');
    const result = electReplan(ctx.makeDeps(), { graphRunId: ctx.graphRunId });
    expect(result).toEqual({ elected: false, reason: 'not-running' });
    expect(runRow(ctx)).toMatchObject({ status: 'blocked', replan_count: 0 });
  });

  it('a later replan request while draining is persisted as bounded evidence and launches no planner', () => {
    const ctx = harness(1);
    electReplan(ctx.makeDeps(), { graphRunId: ctx.graphRunId });
    // A second node reports replan with a bounded reason (the CLI recorded the
    // node's row before the host ran the election — that row IS the evidence).
    nodeRun(ctx, 31, 'b');
    ctx.db
      .prepare(
        `UPDATE approach_node_runs
         SET status = 'blocked', outcome = 'replan', reason = 'redo from node b'
         WHERE id = 31`,
      )
      .run();
    const later = electReplan(ctx.makeDeps(), {
      graphRunId: ctx.graphRunId,
      requestNodeRunId: 31,
    });
    expect(later).toEqual({ elected: false, reason: 'draining' });
    expect(runRow(ctx)).toMatchObject({ status: 'draining', replan_count: 1 });
    expect(nodeRow(ctx, 31)).toMatchObject({ outcome: 'replan', reason: 'redo from node b' });
    const planners = ctx.db
      .prepare('SELECT COUNT(*) AS n FROM approach_planner_runs')
      .get() as { n: number };
    expect(planners.n).toBe(0);
  });

  it('replan budget exhaustion refuses: the node blocks, the run blocks, no election', () => {
    const ctx = harness(1, 'running', 1);
    nodeRun(ctx, 41, 'a');
    ctx.db
      .prepare(
        `UPDATE approach_node_runs
         SET status = 'blocked', outcome = 'replan', reason = 'redo'
         WHERE id = 41`,
      )
      .run();
    const result = electReplan(ctx.makeDeps(), {
      graphRunId: ctx.graphRunId,
      requestNodeRunId: 41,
    });
    expect(result).toEqual({ elected: false, reason: 'max-replans-exhausted' });
    expect(nodeRow(ctx, 41)).toMatchObject({
      outcome: 'replan',
      effective_outcome: 'blocked',
      reason: 'graph-budget-exhausted',
      failure_category: 'graph-budget-exhausted',
    });
    expect(runRow(ctx)).toMatchObject({
      status: 'blocked',
      blocked_reason: 'graph-budget-exhausted',
      replan_count: 1,
    });
    const revision = ctx.db
      .prepare('SELECT status FROM approach_graph_revisions WHERE id = ?')
      .get(ctx.revisionId) as { status: string };
    expect(revision.status).toBe('active');
  });
});

describe('beginReplanPlannerRun — quiescence, planner allocation, reasons file (steps 5–7)', () => {
  function electedCtx(): Ctx {
    const ctx = harness(1);
    // The bootstrap planner run (#1) exists before the replan election; the
    // replan allocates the NEXT monotonic counter.
    plannerRun(ctx, 1, 1, 'submitted', { kind: 'bootstrap' });
    electReplan(ctx.makeDeps(), { graphRunId: ctx.graphRunId });
    return ctx;
  }

  function launchDeps(ctx: Ctx, overrides?: Partial<ReplanLaunchDeps>): ReplanLaunchDeps {
    const writes: { relativePath: string; bytes: Uint8Array }[] = [];
    const base: ReplanLaunchDeps = {
      ...ctx.makeDeps(),
      writeSnapshot: (_graphRunId, relativePath, bytes) => {
        writes.push({ relativePath, bytes });
      },
      readPrompt: () => new TextEncoder().encode('# planner'),
      promptPath: '/prompts/graph-planner.md',
      ticketContext: 'context: T-1',
    };
    return { ...base, ...overrides };
  }

  it('allocates exactly one replan planner run with the next counter once the drain quiesces', () => {
    const ctx = electedCtx();
    const deps = launchDeps(ctx);
    const writes: { relativePath: string; bytes: Uint8Array }[] = [];
    deps.writeSnapshot = (_g, relativePath, bytes) => {
      writes.push({ relativePath, bytes });
    };
    const result = beginReplanPlannerRun(deps, { graphRunId: ctx.graphRunId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plannerRunNumber).toBe(2);
    const run = ctx.db
      .prepare('SELECT * FROM approach_planner_runs WHERE id = ?')
      .get(result.plannerRunId) as {
        kind: string;
        status: string;
        prompt_hash: string | null;
        artifact_snapshot_id: string | null;
        graph_snapshot_id: string | null;
      };
    expect(run).toMatchObject({ kind: 'replan', status: 'ready' });
    expect(run.prompt_hash).toBeTruthy();
    expect(run.artifact_snapshot_id).toBeTruthy();
    // The reasons file artifact is written and pointed to — never argv.
    const reasonsWrite = writes.find((w) => w.relativePath.startsWith('reasons/'));
    expect(reasonsWrite).toBeDefined();
    expect(run.graph_snapshot_id).toBe(reasonsWrite!.relativePath);
    const reasons = JSON.parse(new TextDecoder().decode(reasonsWrite!.bytes)) as {
      elected: unknown[];
      secondary: unknown[];
    };
    expect(Array.isArray(reasons.elected)).toBe(true);
    expect(Array.isArray(reasons.secondary)).toBe(true);
    expect(result.launch).toMatchObject({
      graphRunId: ctx.graphRunId,
      plannerRunId: result.plannerRunId,
      plannerRunNumber: 2,
      supersedesRevisionId: ctx.revisionId,
      priorRevisionNumber: 1,
      ticketContext: 'context: T-1',
      reasonsSnapshotPath: run.graph_snapshot_id,
    });
    const planners = ctx.db
      .prepare("SELECT COUNT(*) AS n FROM approach_planner_runs WHERE kind = 'replan'")
      .get() as { n: number };
    expect(planners.n).toBe(1);
  });

  it('refuses before quiescence: a running node blocks the planner run', () => {
    const ctx = electedCtx();
    nodeRun(ctx, 51, 'a', 'running');
    const result = beginReplanPlannerRun(launchDeps(ctx), { graphRunId: ctx.graphRunId });
    expect(result).toEqual({ ok: false, reason: 'not-quiescent' });
    const replanRuns = ctx.db
      .prepare("SELECT COUNT(*) AS n FROM approach_planner_runs WHERE kind = 'replan'")
      .get() as { n: number };
    expect(replanRuns.n).toBe(0);
  });

  it('is a no-op once the run has left draining (a concurrent replan landed N+1)', () => {
    const ctx = electedCtx();
    setRunStatus(ctx, 'running');
    const result = beginReplanPlannerRun(launchDeps(ctx), { graphRunId: ctx.graphRunId });
    expect(result).toEqual({ ok: false, reason: 'not-draining' });
    const replanRuns = ctx.db
      .prepare("SELECT COUNT(*) AS n FROM approach_planner_runs WHERE kind = 'replan'")
      .get() as { n: number };
    expect(replanRuns.n).toBe(0);
  });
});

describe('submitReplanDocument — validate, supersede, resume (steps 8–10)', () => {
  function drainingWithPlanner(): { ctx: Ctx; plannerRunId: number } {
    const ctx = harness(1);
    electReplan(ctx.makeDeps(), { graphRunId: ctx.graphRunId });
    plannerRun(ctx, 2, 2, 'running', { graphSnapshotId: 'reasons/abc.json' });
    return { ctx, plannerRunId: 2 };
  }

  it('N+1 supersedes N: active → superseded, supersedes_revision_id set, history not rewritten', () => {
    const { ctx, plannerRunId } = drainingWithPlanner();
    const before = ctx.db
      .prepare('SELECT canonical_graph FROM approach_graph_revisions WHERE id = ?')
      .get(ctx.revisionId) as { canonical_graph: string };

    const result = submitReplanDocument(submitDeps(ctx), {
      plannerRunId,
      document: draftN1(),
      rationale: 'redo from node b',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.deferredNodeIds).toEqual([]);

    const oldRev = ctx.db
      .prepare('SELECT * FROM approach_graph_revisions WHERE id = ?')
      .get(ctx.revisionId) as {
        status: string;
        superseded_at: string | null;
        canonical_graph: string;
      };
    expect(oldRev.status).toBe('superseded');
    expect(oldRev.superseded_at).toBe(ctx.now);
    expect(oldRev.canonical_graph).toBe(before.canonical_graph);

    const n1 = ctx.db
      .prepare(
        'SELECT * FROM approach_graph_revisions WHERE graph_run_id = ? AND revision_number = 2',
      )
      .get(ctx.graphRunId) as {
        status: string;
        supersedes_revision_id: number | null;
        reason: string | null;
        canonical_graph: string;
        planner_graph_snapshot_id: string | null;
        planner_artifact_snapshot_id: string | null;
      };
    expect(n1.status).toBe('active');
    expect(n1.supersedes_revision_id).toBe(ctx.revisionId);
    expect(n1.reason).toBe('redo from node b');
    expect(n1.planner_graph_snapshot_id).toBe('fp-N1');
    expect(n1.planner_artifact_snapshot_id).toBe('reasons/abc.json');

    const planner = ctx.db
      .prepare('SELECT status, submitted_at, graph_snapshot_id FROM approach_planner_runs WHERE id = ?')
      .get(plannerRunId) as { status: string; submitted_at: string | null; graph_snapshot_id: string | null };
    expect(planner).toMatchObject({ status: 'submitted', submitted_at: ctx.now, graph_snapshot_id: 'fp-N1' });

    expect(runRow(ctx).status).toBe('running');

    // N+1's root entry tokens are created; scheduling resumes.
    const entries = ctx.db
      .prepare(
        `SELECT edge_id, destination_node_id, status FROM approach_graph_tokens
         WHERE revision_id = ? AND is_entry = 1`,
      )
      .all(result.revisionId) as { edge_id: string; destination_node_id: string; status: string }[];
    expect(entries).toEqual([
      { edge_id: 'entry-b', destination_node_id: 'b', status: 'pending' },
    ]);
  });

  it('a late submission for a competed revision is a no-op: planner stale, no revision N+1', () => {
    const { ctx, plannerRunId } = drainingWithPlanner();
    // A concurrent replan already won and landed N+1 — the run resumed.
    setRunStatus(ctx, 'running');
    setRevisionStatus(ctx, ctx.revisionId, 'superseded');
    const revisionsBefore = revisionCount(ctx);

    const result = submitReplanDocument(submitDeps(ctx), {
      plannerRunId,
      document: draftN1(),
      rationale: 'late',
    });
    expect(result).toEqual({ ok: false, reason: 'not-draining' });
    const planner = ctx.db
      .prepare('SELECT status FROM approach_planner_runs WHERE id = ?')
      .get(plannerRunId) as { status: string };
    expect(planner.status).toBe('stale');
    expect(revisionCount(ctx)).toBe(revisionsBefore);
  });

  it('a conflicting resource claim defers instead of failing compile', () => {
    const { ctx, plannerRunId } = drainingWithPlanner();
    // Revision N holds a lease on the physical domain N+1's node claims.
    nodeRun(ctx, 61, 'a');
    ctx.db
      .prepare(
        `INSERT INTO approach_resource_leases
           (graph_run_id, owner_node_run_id, physical_domain, access_mode, status, acquired_at)
         VALUES (?, 61, 'wt-1', 'write', 'held', '2026-08-12T00:00:00.000Z')`,
      )
      .run(ctx.graphRunId);

    const compile = vi.fn((document: GraphDocument) => compileOk(document));
    const result = submitReplanDocument(
      submitDeps(ctx, {
        compileDocument: compile,
        physicalDomainsOf: (nodeId) => (nodeId === 'b' ? ['wt-1'] : []),
      }),
      { plannerRunId, document: draftN1(), rationale: 'redo' },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.deferredNodeIds).toEqual(['b']);
    // Compile ran and succeeded — a lease overlap is never a compile error.
    expect(compile).toHaveBeenCalledTimes(1);
    const planner = ctx.db
      .prepare('SELECT reason FROM approach_planner_runs WHERE id = ?')
      .get(plannerRunId) as { reason: string | null };
    expect(planner.reason).toContain('b');
    expect(runRow(ctx).status).toBe('running');
  });

  it('an invalid document is rejected and leaves the drain in place', () => {
    const { ctx, plannerRunId } = drainingWithPlanner();
    const result = submitReplanDocument(
      submitDeps(ctx, {
        compileDocument: () => ({
          ok: false as const,
          diagnostics: [{ code: 'empty-entries', where: 'entries', message: 'x', severity: 'error' as const }],
        }),
      }),
      { plannerRunId, document: draftN1(), rationale: 'redo' },
    );
    expect(result).toEqual({ ok: false, reason: 'invalid-document' });
    expect(runRow(ctx).status).toBe('draining');
    expect(revisionCount(ctx)).toBe(1);
  });
});
