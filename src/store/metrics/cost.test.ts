import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../db.js';
import { createTicket } from '../tickets.js';
import { upsertProject } from '../projects.js';
import { agentActiveTime, graphEfficiency, tokenBurn } from './cost.js';

describe('cost metrics', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  const usage = (input: {
    projectId?: number;
    ticketId?: number;
    callSite: string;
    total: number;
    estimated?: number;
    provider?: string;
    model?: string;
    recordedAt?: string;
  }): void => {
    store.db
      .prepare(
        `INSERT INTO token_usage
           (project_id, ticket_id, call_site, provider, model, input_tokens, output_tokens,
            total_tokens, estimated, outcome, recorded_at)
         VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, 'ok', ?)`,
      )
      .run(
        input.projectId ?? null,
        input.ticketId ?? null,
        input.callSite,
        input.provider ?? 'anthropic',
        input.model ?? 'claude',
        input.total,
        input.estimated ?? 0,
        input.recordedAt ?? '2026-07-20T00:00:00.000Z',
      );
  };

  it('splits token burn by call site, provider, model, and reported vs estimated', () => {
    const p = upsertProject(store, { slug: 'p' });
    usage({ projectId: p.id, callSite: 'gate', total: 100 });
    usage({ projectId: p.id, callSite: 'gate', total: 50, estimated: 1 });
    usage({ projectId: p.id, callSite: 'commit', total: 25, provider: 'openai', model: 'gpt' });

    const result = tokenBurn(store, { projectId: p.id });
    expect(result).toMatchObject({ calls: 3, reportedTokens: 125, estimatedTokens: 50 });
    expect(result.byCallSite).toEqual([
      { callSite: 'commit', calls: 1, reportedTokens: 25, estimatedTokens: 0 },
      { callSite: 'gate', calls: 2, reportedTokens: 100, estimatedTokens: 50 },
    ]);
    expect(result.byProvider).toEqual([
      { provider: 'anthropic', calls: 2, reportedTokens: 100, estimatedTokens: 50 },
      { provider: 'openai', calls: 1, reportedTokens: 25, estimatedTokens: 0 },
    ]);
    expect(result.byModel.map((m) => m.model)).toEqual(['claude', 'gpt']);
  });

  it('reports cost per merged ticket only when a ticket has merged', () => {
    const t = createTicket(store, { key: 'A', title: 'a' });
    usage({ ticketId: t.id, callSite: 'gate', total: 200 });
    expect(tokenBurn(store, {}).perMergedTicket).toBeNull();

    store.db
      .prepare(
        `INSERT INTO prs (ticket_id, repo, number, merged_at) VALUES (?, 'one', 1, '2026-07-21T00:00:00.000Z')`,
      )
      .run(t.id);
    const merged = tokenBurn(store, {});
    expect(merged.mergedTickets).toBe(1);
    expect(merged.perMergedTicket).toBeCloseTo(200);
  });

  it('sums agent-active wall clock over process and implementation runs', () => {
    const t = createTicket(store, { key: 'A', title: 'a' });
    const run = store.db
      .prepare(
        `INSERT INTO process_runs (ticket_id, stage_key, process_id, attempt, status, started_at, ended_at)
         VALUES (?, 'impl', 'p', 0, 'passed', '2026-07-20T00:00:00.000Z', '2026-07-20T01:00:00.000Z')`,
      )
      .run(t.id);
    // A run still open contributes nothing — its duration is not yet a fact.
    store.db
      .prepare(
        `INSERT INTO process_runs (ticket_id, stage_key, process_id, attempt, status, started_at)
         VALUES (?, 'impl', 'p2', 0, 'running', '2026-07-20T02:00:00.000Z')`,
      )
      .run(t.id);
    store.db
      .prepare(
        `INSERT INTO implementation_runs (ticket_id, process_run_id, attempt, status, started_at, ended_at)
         VALUES (?, ?, 0, 'passed', '2026-07-20T00:00:00.000Z', '2026-07-20T00:30:00.000Z')`,
      )
      .run(t.id, Number(run.lastInsertRowid));

    const result = agentActiveTime(store, {});
    expect(result.processRunHours).toBeCloseTo(1);
    expect(result.implementationRunHours).toBeCloseTo(0.5);
    expect(result.openRuns).toBe(1);
  });

  it('reports graph replans per node run and node failure categories', () => {
    const t = createTicket(store, { key: 'A', title: 'a' });
    const graph = store.db
      .prepare(
        `INSERT INTO approach_graph_runs
           (ticket_id, stage_key, stage_attempt, approach_id, status, node_run_count, replan_count, created_at)
         VALUES (?, 'impl', 0, 'a', 'closed', 4, 2, '2026-07-20T00:00:00.000Z')`,
      )
      .run(t.id);
    const revision = store.db
      .prepare(
        `INSERT INTO approach_graph_revisions
           (graph_run_id, revision_number, canonical_graph, fingerprint, status, created_at)
         VALUES (?, 1, '{}', 'f', 'active', '2026-07-20T00:00:00.000Z')`,
      )
      .run(Number(graph.lastInsertRowid));
    store.db
      .prepare(
        `INSERT INTO approach_node_runs
           (graph_run_id, revision_id, node_id, node_kind, visit_number, status, failure_category, started_at)
         VALUES (?, ?, 'n1', 'expert', 1, 'blocked', 'launch', '2026-07-20T00:00:00.000Z')`,
      )
      .run(Number(graph.lastInsertRowid), Number(revision.lastInsertRowid));

    const result = graphEfficiency(store, {});
    expect(result).toMatchObject({ graphRuns: 1, nodeRuns: 4, replans: 2 });
    expect(result.replansPerNodeRun).toBeCloseTo(0.5);
    expect(result.byFailureCategory).toEqual([{ failureCategory: 'launch', count: 1 }]);
  });
});
