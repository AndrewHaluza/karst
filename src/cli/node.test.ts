/**
 * `karst node complete | block | replan` tests (Slice 3 Task 5).
 *
 * Closed parser, capability-authenticated one-shot mutation, outcome
 * validation against the pinned node definition, the replan precondition,
 * and every idempotent rejection class.
 */

import { describe, it, expect } from 'vitest';
import { openStore } from '../store/db.js';
import {
  parseNodeArgs,
  runNodeCommand,
  sanitizeEvidence,
  sha256Hex,
  hasQualifyingPrecondition,
  AGENT_REPORTED_PREFIX,
  MAX_REASON_CHARS,
} from './node.js';

const CAPABILITY = 'cap-secret-256-bits';
const CAP_HASH = sha256Hex(new TextEncoder().encode(CAPABILITY));

function doc(): string {
  return JSON.stringify({
    version: 1,
    title: 't',
    rationaleArtifact: 'r',
    entries: ['worker-a'],
    artifacts: [],
    nodes: [
      {
        id: 'worker-a',
        kind: 'agent',
        label: 'Worker',
        profile: 'worker',
        instructionsArtifact: 'instr',
        inputs: [],
        outputs: [],
        resources: { reads: [], writes: [] },
        outcomes: ['complete', 'blocked', 'replan'],
        budget: { maxVisits: 3 },
      },
      {
        id: 'verify',
        kind: 'command',
        label: 'Verify',
        command: 'test',
        repositories: ['api'],
        outcomes: ['passed', 'failed', 'infrastructure-error'],
        budget: { maxVisits: 3 },
      },
    ],
    edges: [{ id: 'a-end', from: 'worker-a', on: 'complete', to: 'END' }],
    budgets: { maxNodeRuns: 10, maxExpertRuns: 2, maxReplans: 1 },
  });
}

interface Ctx {
  store: ReturnType<typeof openStore>;
  db: ReturnType<typeof openStore>['db'];
  graphRunId: number;
  revisionId: number;
  projectId: number;
  env: Record<string, string>;
}

function harness(): Ctx {
  const store = openStore(':memory:');
  const db = store.db;
  const projectId = Number(
    db.prepare("INSERT INTO projects (slug, name) VALUES ('p', 'P')").run().lastInsertRowid,
  );
  const ticketId = Number(
    db
      .prepare(
        "INSERT INTO tickets (key, project_id, stage_current) VALUES ('T-1', ?, 'impl')",
      )
      .run(projectId)
      .lastInsertRowid,
  );
  db.prepare(
    "INSERT INTO stages (ticket_id, stage_key, status, attempt) VALUES (?, 'impl', 'running', 0)",
  ).run(ticketId);
  const graphRunId = Number(
    db
      .prepare(
        `INSERT INTO approach_graph_runs (ticket_id, stage_key, stage_attempt, approach_id, status, created_at)
         VALUES (?, 'impl', 0, 'karst-graph-engineering', 'running', '2026-08-12T00:00:00.000Z')`,
      )
      .run(ticketId)
      .lastInsertRowid,
  );
  const revisionId = Number(
    db
      .prepare(
        `INSERT INTO approach_graph_revisions
           (graph_run_id, revision_number, canonical_graph, fingerprint, status, created_at)
         VALUES (?, 1, ?, 'fp', 'active', '2026-08-12T00:00:00.000Z')`,
      )
      .run(graphRunId, doc())
      .lastInsertRowid,
  );
  const env = {
    KARST_GRAPH_PROJECT: String(projectId),
    KARST_TICKET_ID: String(ticketId),
    KARST_GRAPH_RUN_ID: String(graphRunId),
    KARST_LAUNCH_ID: '1',
    KARST_GRAPH_GENERATION: 'gen-1',
    KARST_GRAPH_CAPABILITY: CAPABILITY,
  };
  return { store, db, graphRunId, revisionId, projectId, env };
}

function insertNodeRun(
  db: Ctx['db'],
  ctx: Ctx,
  overrides: Partial<{
    id: number;
    nodeId: string;
    nodeKind: string;
    status: string;
    generation: string;
    capabilityHash: string | null;
    outcome: string | null;
    reason: string | null;
  }> = {},
): void {
  const nodeId = overrides.nodeId ?? 'worker-a';
  const nextVisit = (
    db
      .prepare(
        'SELECT COALESCE(MAX(visit_number), 0) + 1 AS next FROM approach_node_runs WHERE revision_id = ? AND node_id = ?',
      )
      .get(ctx.revisionId, nodeId) as { next: number }
  ).next;
  db.prepare(
    `INSERT INTO approach_node_runs
       (id, graph_run_id, revision_id, node_id, node_kind, visit_number, status,
        generation, capability_hash, outcome, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    overrides.id ?? 1,
    ctx.graphRunId,
    ctx.revisionId,
    nodeId,
    overrides.nodeKind ?? 'agent',
    nextVisit,
    overrides.status ?? 'running',
    overrides.generation ?? 'gen-1',
    overrides.capabilityHash === undefined ? CAP_HASH : overrides.capabilityHash,
    overrides.outcome ?? null,
    overrides.reason ?? null,
  );
}

function envOf(ctx: Ctx, overrides: Record<string, string> = {}): Record<string, string> {
  return { ...ctx.env, ...overrides };
}

describe('parseNodeArgs', () => {
  it('accepts only the verb and a bounded --reason for block/replan', () => {
    expect(parseNodeArgs(['node', 'complete'])).toEqual({ verb: 'complete', reason: undefined });
    expect(parseNodeArgs(['node', 'block', '--reason', 'gate failed'])).toEqual({
      verb: 'block',
      reason: 'gate failed',
    });
    expect(parseNodeArgs(['node', 'replan', '--reason', 'x'])).toEqual({ verb: 'replan', reason: 'x' });
  });

  it('rejects trailing argv, unknown verbs, and --reason on complete', () => {
    expect(() => parseNodeArgs(['node', 'complete', 'extra'])).toThrow(/takes at most/);
    expect(() => parseNodeArgs(['node', 'complete', '--reason', 'x'])).toThrow(/takes no --reason/);
    expect(() => parseNodeArgs(['node', 'complete', '--ticket', '5'])).toThrow(/takes at most/);
    expect(() => parseNodeArgs(['node', 'pass'])).toThrow(/unknown node verb/);
    expect(() => parseNodeArgs(['node', 'block', '--reason', 'x', '--reason', 'y'])).toThrow(
      /takes at most/,
    );
  });

  it('caps and collapses reason evidence', () => {
    const long = `a\tb\nc ${'x'.repeat(MAX_REASON_CHARS + 50)}`;
    const clean = sanitizeEvidence(long)!;
    expect(clean).toBe(`a b c ${'x'.repeat(MAX_REASON_CHARS - 6)}`);
    expect(clean.length).toBeLessThanOrEqual(MAX_REASON_CHARS);
    expect(AGENT_REPORTED_PREFIX).toBe('[agent-reported]');
  });
});

describe('runNodeCommand — capability-authenticated one-shot completion', () => {
  it('complete moves running → completing with outcome complete', () => {
    const ctx = harness();
    insertNodeRun(ctx.db, ctx);
    const out = JSON.parse(runNodeCommand(ctx.store, ctx.env, ['node', 'complete'])) as {
      ok: boolean;
      outcome: string;
    };
    expect(out).toMatchObject({ ok: true, outcome: 'complete' });
    const run = ctx.db.prepare('SELECT status, outcome, ended_at FROM approach_node_runs WHERE id = 1').get() as {
      status: string;
      outcome: string | null;
      ended_at: string | null;
    };
    expect(run).toMatchObject({ status: 'completing', outcome: 'complete' });
    expect(run.ended_at).not.toBeNull();
  });

  it('block records the bounded reason and moves the run to blocked', () => {
    const ctx = harness();
    insertNodeRun(ctx.db, ctx);
    const out = JSON.parse(
      runNodeCommand(ctx.store, ctx.env, ['node', 'block', '--reason', 'user said stop']),
    ) as { ok: boolean; outcome: string };
    expect(out).toMatchObject({ ok: true, outcome: 'blocked' });
    const run = ctx.db.prepare('SELECT status, outcome, reason FROM approach_node_runs WHERE id = 1').get() as {
      status: string;
      outcome: string | null;
      reason: string | null;
    };
    expect(run).toMatchObject({ status: 'blocked', outcome: 'blocked', reason: 'user said stop' });
  });

  it('the capability is consumed one-shot: block then complete is rejected idempotently', () => {
    const ctx = harness();
    insertNodeRun(ctx.db, ctx);
    const first = JSON.parse(
      runNodeCommand(ctx.store, ctx.env, ['node', 'block', '--reason', 'stuck']),
    ) as { ok: boolean };
    const second = JSON.parse(
      runNodeCommand(ctx.store, ctx.env, ['node', 'complete']),
    ) as { ok: false; rejected: string };
    expect(first.ok).toBe(true);
    expect(second).toMatchObject({ ok: false, rejected: 'duplicate-submission' });
    const run = ctx.db.prepare('SELECT status, outcome FROM approach_node_runs WHERE id = 1').get() as {
      status: string;
      outcome: string | null;
    };
    expect(run).toMatchObject({ status: 'blocked', outcome: 'blocked' });
  });

  it('rejects unknown runs, wrong graph, stale generation, wrong capability, wrong project', () => {
    const ctx = harness();
    insertNodeRun(ctx.db, ctx);
    const cases: [Record<string, string>, string][] = [
      [{ KARST_LAUNCH_ID: '999' }, 'unknown-run'],
      [{ KARST_GRAPH_RUN_ID: '999' }, 'unknown-run'],
      [{ KARST_GRAPH_GENERATION: 'gen-2' }, 'stale-generation'],
      [{ KARST_GRAPH_CAPABILITY: 'wrong' }, 'wrong-capability'],
      [{ KARST_GRAPH_PROJECT: '999' }, 'wrong-project'],
    ];
    for (const [override, rejected] of cases) {
      const out = JSON.parse(
        runNodeCommand(ctx.store, envOf(ctx, override), ['node', 'complete']),
      ) as { ok: false; rejected: string };
      expect(out.rejected).toBe(rejected);
    }
    const run = ctx.db.prepare('SELECT status FROM approach_node_runs WHERE id = 1').get() as {
      status: string;
    };
    expect(run.status).toBe('running');
  });

  it('rejects a not-running node and a wrong-attempt graph run', () => {
    const ctx = harness();
    insertNodeRun(ctx.db, ctx, { status: 'ready' });
    const notRunning = JSON.parse(
      runNodeCommand(ctx.store, ctx.env, ['node', 'complete']),
    ) as { ok: false; rejected: string };
    expect(notRunning.rejected).toBe('not-running');

    insertNodeRun(ctx.db, ctx, { id: 2, nodeId: 'worker-a', status: 'running' });
    ctx.db
      .prepare("UPDATE stages SET attempt = 1 WHERE ticket_id = ? AND stage_key = 'impl'")
      .run(Number(ctx.env.KARST_TICKET_ID));
    const wrongAttempt = JSON.parse(
      runNodeCommand(ctx.store, envOf(ctx, { KARST_LAUNCH_ID: '2' }), ['node', 'complete']),
    ) as { ok: false; rejected: string };
    expect(wrongAttempt.rejected).toBe('wrong-attempt');
  });

  it('rejects a verb whose outcome the pinned node does not declare', () => {
    const ctx = harness();
    // The `verify` command node declares no blocked/replan/complete.
    insertNodeRun(ctx.db, ctx, { id: 1, nodeId: 'verify', nodeKind: 'command' });
    for (const verb of ['complete', 'block', 'replan']) {
      const out = JSON.parse(
        runNodeCommand(ctx.store, ctx.env, ['node', verb]),
      ) as { ok: false; rejected: string };
      expect(out.rejected).toBe('unknown-outcome');
    }
    const run = ctx.db.prepare('SELECT status FROM approach_node_runs WHERE id = 1').get() as {
      status: string;
    };
    expect(run.status).toBe('running');
  });
});

describe('replan precondition (Decision 27)', () => {
  function lineageHarness(): { ctx: Ctx } {
    const ctx = harness();
    // Prior run chain: entry worker (blocked) → verify command (failed) →
    // this node (running).
    insertNodeRun(ctx.db, ctx, {
      id: 1,
      nodeId: 'verify',
      nodeKind: 'command',
      status: 'blocked',
      outcome: 'failed',
    });
    insertNodeRun(ctx.db, ctx, {
      id: 2,
      nodeId: 'worker-a',
      status: 'running',
    });
    return { ctx };
  }

  it('walks the causal lineage through the claiming tokens', () => {
    const { ctx } = lineageHarness();
    ctx.db
      .prepare(
        `INSERT INTO approach_graph_tokens
           (revision_id, source_node_run_id, is_entry, edge_id, destination_node_id,
            destination_end, fork_instance, fork_lineage, status, claiming_node_run_id, created_at)
         VALUES (?, NULL, 1, 'entry', 'verify', 0, 0, 'root', 'consumed', 1, ?)`,
      )
      .run(ctx.revisionId, '2026-08-12T00:00:00.000Z');
    ctx.db
      .prepare(
        `INSERT INTO approach_graph_tokens
           (revision_id, source_node_run_id, is_entry, edge_id, destination_node_id,
            destination_end, fork_instance, fork_lineage, status, claiming_node_run_id, created_at)
         VALUES (?, 1, 0, 'v-a', 'worker-a', 0, 0, 'root', 'claimed', 2, ?)`,
      )
      .run(ctx.revisionId, '2026-08-12T00:00:00.000Z');
    expect(hasQualifyingPrecondition(ctx.store, 2)).toBe(true);
  });

  it('replan with a qualifying lineage (failed gate/command) is honored', () => {
    const { ctx } = lineageHarness();
    ctx.db
      .prepare(
        `INSERT INTO approach_graph_tokens
           (revision_id, source_node_run_id, is_entry, edge_id, destination_node_id,
            destination_end, fork_instance, fork_lineage, status, claiming_node_run_id, created_at)
         VALUES (?, NULL, 1, 'entry', 'verify', 0, 0, 'root', 'consumed', 1, ?)`,
      )
      .run(ctx.revisionId, '2026-08-12T00:00:00.000Z');
    ctx.db
      .prepare(
        `INSERT INTO approach_graph_tokens
           (revision_id, source_node_run_id, is_entry, edge_id, destination_node_id,
            destination_end, fork_instance, fork_lineage, status, claiming_node_run_id, created_at)
         VALUES (?, 1, 0, 'v-a', 'worker-a', 0, 0, 'root', 'claimed', 2, ?)`,
      )
      .run(ctx.revisionId, '2026-08-12T00:00:00.000Z');
    const out = JSON.parse(
      runNodeCommand(ctx.store, envOf(ctx, { KARST_LAUNCH_ID: '2' }), ['node', 'replan']),
    ) as { ok: boolean; outcome: string };
    expect(out).toMatchObject({ ok: true, outcome: 'replan' });
  });

  it('replan without qualifying lineage (only its own prior blocked) is treated as blocked', () => {
    const ctx = harness();
    insertNodeRun(ctx.db, ctx, { id: 1, nodeId: 'worker-a', status: 'blocked', outcome: 'blocked' });
    insertNodeRun(ctx.db, ctx, { id: 2, nodeId: 'worker-a', status: 'running' });
    // Lineage: entry → worker (blocked, its own prior block) → this run.
    ctx.db
      .prepare(
        `INSERT INTO approach_graph_tokens
           (revision_id, source_node_run_id, is_entry, edge_id, destination_node_id,
            destination_end, fork_instance, fork_lineage, status, claiming_node_run_id, created_at)
         VALUES (?, NULL, 1, 'entry', 'worker-a', 0, 0, 'root', 'consumed', 1, ?)`,
      )
      .run(ctx.revisionId, '2026-08-12T00:00:00.000Z');
    ctx.db
      .prepare(
        `INSERT INTO approach_graph_tokens
           (revision_id, source_node_run_id, is_entry, edge_id, destination_node_id,
            destination_end, fork_instance, fork_lineage, status, claiming_node_run_id, created_at)
         VALUES (?, 1, 0, 'a-a', 'worker-a', 0, 0, 'root', 'claimed', 2, ?)`,
      )
      .run(ctx.revisionId, '2026-08-12T00:00:00.000Z');
    const out = JSON.parse(
      runNodeCommand(ctx.store, envOf(ctx, { KARST_LAUNCH_ID: '2' }), ['node', 'replan', '--reason', 'redo']),
    ) as { ok: boolean; outcome: string };
    expect(out).toMatchObject({ ok: true, outcome: 'blocked' });
    const run = ctx.db.prepare('SELECT status, outcome, reason FROM approach_node_runs WHERE id = 2').get() as {
      status: string;
      outcome: string | null;
      reason: string | null;
    };
    expect(run).toMatchObject({ status: 'blocked', outcome: 'blocked' });
    expect(run.reason).toContain('replan requested without an observable precondition');
    expect(run.reason).toContain('redo');
  });
});
