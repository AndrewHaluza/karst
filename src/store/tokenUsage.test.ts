import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from './db.js';
import {
  recordTokenUsage,
  queryTokenUsageStats,
  listTokenUsage,
  summarizeRecordedTokenUsage,
  summarizeRecordedTokenUsageForProcess,
  summarizeRecordedTokenUsageByRole,
  EMPTY_USAGE_TOTALS,
} from './tokenUsage.js';
import { parseUsageQuery, type UsageQuery } from './tokenUsageQuery.js';
import { openProcessRun } from './processRuns.js';

function query(overrides: Partial<UsageQuery> = {}): UsageQuery {
  const parsed = parseUsageQuery(overrides);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.query;
}

let store: Store;

function ticket(id: number, key: string, title: string, projectId = 1): void {
  store.db
    .prepare('INSERT INTO tickets (id, key, title, project_id) VALUES (?, ?, ?, ?)')
    .run(id, key, title, projectId);
}

interface Seed {
  ticketId?: number | null;
  processRunId?: number | null;
  callSite?: string;
  model?: string | null;
  provider?: string;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  estimated?: boolean;
  outcome?: 'ok' | 'error';
  at?: string;
}

function seed(s: Seed = {}): void {
  const input = s.input ?? 10;
  const output = s.output ?? 5;
  const cacheRead = s.cacheRead ?? 0;
  const cacheWrite = s.cacheWrite ?? 0;
  recordTokenUsage(store, {
    projectId: 1,
    ticketId: s.ticketId === undefined ? 1 : s.ticketId,
    processRunId: s.processRunId === undefined ? null : s.processRunId,
    callSite: s.callSite ?? 'ticket-analysis',
    provider: s.provider ?? 'claude',
    outcome: s.outcome ?? 'ok',
    recordedAt: s.at ?? '2026-07-15T00:00:00.000Z',
    usage: {
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      totalTokens: input + output + cacheRead + cacheWrite,
      model: s.model === undefined ? 'claude-opus-5' : s.model,
      estimated: s.estimated ?? false,
    },
  });
}

beforeEach(() => {
  store = openStore(':memory:');
  store.db.prepare('INSERT INTO projects (id, slug) VALUES (?, ?)').run(1, 'karst');
  store.db.prepare('INSERT INTO projects (id, slug) VALUES (?, ?)').run(2, 'other');
});
afterEach(() => store.close());

describe('recordTokenUsage', () => {
  it('appends one row per call and never updates an earlier one', () => {
    ticket(1, 'K-1', 'One');
    seed({ input: 10 });
    seed({ input: 20 });
    const rows = store.db
      .prepare('SELECT input_tokens FROM token_usage ORDER BY id')
      .all() as { input_tokens: number }[];
    expect(rows.map((r) => r.input_tokens)).toEqual([10, 20]);
  });

  it('stores no prompt or completion text — the table has no column for it', () => {
    const columns = store.db
      .prepare("PRAGMA table_info('token_usage')")
      .all()
      .map((r) => (r as { name: string }).name);
    for (const forbidden of ['prompt', 'completion', 'text', 'body', 'raw', 'result']) {
      expect(columns, `token_usage must not carry ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('carries the v29 interactive sample linkage, NULL for ordinary ledger writes', () => {
    ticket(1, 'K-1', 'One');
    seed({ input: 10 });
    const row = store.db.prepare('SELECT interactive_usage_sample_id FROM token_usage').get() as {
      interactive_usage_sample_id: number | null;
    };
    expect(row.interactive_usage_sample_id).toBeNull();
    const index = store.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?",
      )
      .get('idx_token_usage_interactive_sample');
    expect(index).toEqual({ name: 'idx_token_usage_interactive_sample' });
  });

  it('carries the v35 graph linkage, NULL for ordinary ledger writes', () => {
    ticket(1, 'K-1', 'One');
    seed({ input: 10 });
    const row = store.db.prepare('SELECT approach_planner_run_id, approach_node_run_id FROM token_usage').get() as {
      approach_planner_run_id: number | null;
      approach_node_run_id: number | null;
    };
    expect(row).toEqual({ approach_planner_run_id: null, approach_node_run_id: null });
  });

  it('writes and reads back the graph run linkage a graph launch carries', () => {
    ticket(1, 'K-1', 'One');
    const T = '2026-08-12T00:00:00.000Z';
    store.db
      .prepare(
        `INSERT INTO approach_graph_runs
           (id, ticket_id, stage_key, stage_attempt, approach_id, status, created_at)
         VALUES (?, 1, 'impl', 1, 'graph', 'running', ?)`,
      )
      .run(1, T);
    store.db
      .prepare(
        `INSERT INTO approach_graph_revisions
           (id, graph_run_id, revision_number, canonical_graph, fingerprint, status, created_at)
         VALUES (?, 1, 1, 'graph: []', 'fp', 'active', ?)`,
      )
      .run(1, T);
    store.db
      .prepare(
        `INSERT INTO approach_planner_runs
           (id, graph_run_id, planner_run_number, kind, status)
         VALUES (3, 1, 1, 'bootstrap', 'running')`,
      )
      .run();
    store.db
      .prepare(
        `INSERT INTO approach_node_runs
           (id, graph_run_id, revision_id, node_id, node_kind, visit_number, status)
         VALUES (9, 1, 1, 'n1', 'agent', 1, 'running')`,
      )
      .run();
    recordTokenUsage(store, {
      projectId: 1,
      ticketId: 1,
      processRunId: 5,
      approachPlannerRunId: 3,
      approachNodeRunId: 9,
      callSite: 'graph-node',
      provider: 'codex',
      outcome: 'ok',
      recordedAt: T,
      usage: {
        inputTokens: 40,
        outputTokens: 10,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 50,
        model: 'sol',
        estimated: false,
      },
    });
    const listed = listTokenUsage(store, { ticketId: 1 });
    expect(listed).toHaveLength(1);
    expect(listed[0]!.approachPlannerRunId).toBe(3);
    expect(listed[0]!.approachNodeRunId).toBe(9);
    expect(listed[0]!.callSite).toBe('graph-node');
  });

  it('records a call made before the ticket exists, unattributed', () => {
    seed({ ticketId: null });
    const row = store.db.prepare('SELECT ticket_id FROM token_usage').get() as {
      ticket_id: number | null;
    };
    expect(row.ticket_id).toBeNull();
  });

  it('stamps the row itself when the caller names no time', () => {
    recordTokenUsage(store, {
      projectId: 1,
      ticketId: null,
      callSite: 'pr-description',
      outcome: 'ok',
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 2,
        model: null,
        estimated: false,
      },
    });
    const row = store.db.prepare('SELECT recorded_at FROM token_usage').get() as {
      recorded_at: string;
    };
    expect(row.recorded_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('queryTokenUsageStats', () => {
  it('reports the empty state as zeroes and no groups, not as an error', () => {
    const stats = queryTokenUsageStats(store, query({ projectId: 1 }));
    expect(stats.totals).toEqual(EMPTY_USAGE_TOTALS);
    expect(stats.byCallSite).toEqual([]);
    expect(stats.byModel).toEqual([]);
    expect(stats.byTicket).toEqual([]);
    expect(stats.ticketGroups).toBe(0);
  });

  it('sums overall totals across every call', () => {
    ticket(1, 'K-1', 'One');
    seed({ input: 10, output: 5, cacheRead: 100, cacheWrite: 3 });
    seed({ input: 20, output: 7 });
    const { totals } = queryTokenUsageStats(store, query({ projectId: 1 }));
    expect(totals).toEqual({
      calls: 2,
      inputTokens: 30,
      outputTokens: 12,
      cacheReadTokens: 100,
      cacheWriteTokens: 3,
      totalTokens: 145,
      estimatedCalls: 0,
      erroredCalls: 0,
    });
  });

  it('counts an errored call — the tokens were spent either way', () => {
    ticket(1, 'K-1', 'One');
    seed({ outcome: 'error', input: 9, output: 0 });
    const { totals } = queryTokenUsageStats(store, query({ projectId: 1 }));
    expect(totals.calls).toBe(1);
    expect(totals.erroredCalls).toBe(1);
    expect(totals.inputTokens).toBe(9);
  });

  it('counts estimated calls separately so an approximation is visible', () => {
    ticket(1, 'K-1', 'One');
    seed({ estimated: true });
    seed({ estimated: false });
    expect(queryTokenUsageStats(store, query({ projectId: 1 })).totals.estimatedCalls).toBe(1);
  });

  it('breaks down by call site, heaviest first', () => {
    ticket(1, 'K-1', 'One');
    seed({ callSite: 'ticket-analysis', input: 5, output: 1 });
    seed({ callSite: 'pr-description', input: 50, output: 10 });
    seed({ callSite: 'pr-description', input: 1, output: 1 });
    const { byCallSite } = queryTokenUsageStats(store, query({ projectId: 1 }));
    expect(byCallSite.map((r) => [r.key, r.totalTokens, r.calls])).toEqual([
      ['pr-description', 62, 2],
      ['ticket-analysis', 6, 1],
    ]);
  });

  it('breaks down by model, and keeps an unreported model as its own group', () => {
    ticket(1, 'K-1', 'One');
    seed({ model: 'claude-opus-5', input: 10, output: 0 });
    seed({ model: null, input: 4, output: 0 });
    const { byModel } = queryTokenUsageStats(store, query({ projectId: 1 }));
    expect(byModel.map((r) => [r.key, r.totalTokens])).toEqual([
      ['claude-opus-5', 10],
      ['', 4],
    ]);
  });

  it('lists per-ticket rows with the ticket key and title', () => {
    ticket(1, 'K-1', 'One');
    ticket(2, 'K-2', 'Two');
    seed({ ticketId: 1, input: 5, output: 0 });
    seed({ ticketId: 2, input: 50, output: 0 });
    const { byTicket } = queryTokenUsageStats(store, query({ projectId: 1 }));
    expect(byTicket.map((r) => [r.ticketId, r.ticketKey, r.ticketTitle, r.totalTokens])).toEqual([
      [2, 'K-2', 'Two', 50],
      [1, 'K-1', 'One', 5],
    ]);
  });

  it('keeps unattributed calls as their own row rather than dropping them', () => {
    ticket(1, 'K-1', 'One');
    seed({ ticketId: null, input: 7, output: 0 });
    const { byTicket, totals } = queryTokenUsageStats(store, query({ projectId: 1 }));
    expect(byTicket).toHaveLength(1);
    expect(byTicket[0]!.ticketId).toBeNull();
    expect(byTicket[0]!.ticketKey).toBeNull();
    expect(totals.totalTokens).toBe(7);
  });

  // t1: 1 call  in 5   out 50 → total 55
  // t2: 3 calls in 30  out 5  → total 35
  // t3: 2 calls in 100 out 1  → total 101
  // Every ordering below is strict — no two tickets tie on any sort key.
  it.each([
    ['total', [3, 1, 2]],
    ['input', [3, 2, 1]],
    ['output', [1, 2, 3]],
    ['calls', [2, 3, 1]],
  ] as const)('orders the ticket table by %s', (sort, expected) => {
    ticket(1, 'K-1', 'One');
    ticket(2, 'K-2', 'Two');
    ticket(3, 'K-3', 'Three');
    seed({ ticketId: 1, input: 5, output: 50 });
    seed({ ticketId: 2, input: 30, output: 5 });
    seed({ ticketId: 2, input: 0, output: 0 });
    seed({ ticketId: 2, input: 0, output: 0 });
    seed({ ticketId: 3, input: 100, output: 1 });
    seed({ ticketId: 3, input: 0, output: 0 });
    const { byTicket } = queryTokenUsageStats(store, query({ projectId: 1, sort }));
    expect(byTicket.map((r) => r.ticketId)).toEqual(expected);
  });

  it('orders by recency when asked', () => {
    ticket(1, 'K-1', 'One');
    ticket(2, 'K-2', 'Two');
    seed({ ticketId: 1, at: '2026-07-01T00:00:00.000Z', input: 999 });
    seed({ ticketId: 2, at: '2026-07-20T00:00:00.000Z', input: 1 });
    const { byTicket } = queryTokenUsageStats(store, query({ projectId: 1, sort: 'recent' }));
    expect(byTicket.map((r) => r.ticketId)).toEqual([2, 1]);
    expect(byTicket[0]!.lastAt).toBe('2026-07-20T00:00:00.000Z');
  });

  it('cuts on the time range, inclusive at both ends', () => {
    ticket(1, 'K-1', 'One');
    seed({ at: '2026-06-30T23:59:59.000Z', input: 1, output: 0 });
    seed({ at: '2026-07-01T00:00:00.000Z', input: 2, output: 0 });
    seed({ at: '2026-07-31T00:00:00.000Z', input: 4, output: 0 });
    seed({ at: '2026-08-01T00:00:01.000Z', input: 8, output: 0 });
    const stats = queryTokenUsageStats(
      store,
      query({
        projectId: 1,
        from: '2026-07-01T00:00:00.000Z',
        to: '2026-08-01T00:00:00.000Z',
      }),
    );
    expect(stats.totals.totalTokens).toBe(6);
  });

  it('scopes to one project — a second window’s spend is not this project’s', () => {
    ticket(1, 'K-1', 'One', 1);
    seed({ input: 5, output: 0 });
    recordTokenUsage(store, {
      projectId: 2,
      ticketId: null,
      callSite: 'pr-description',
      outcome: 'ok',
      recordedAt: '2026-07-15T00:00:00.000Z',
      usage: {
        inputTokens: 500,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 500,
        model: null,
        estimated: false,
      },
    });
    expect(queryTokenUsageStats(store, query({ projectId: 1 })).totals.totalTokens).toBe(5);
    expect(queryTokenUsageStats(store, query({ projectId: 2 })).totals.totalTokens).toBe(500);
    // Unscoped is the deliberate all-projects view (recovery only).
    expect(queryTokenUsageStats(store, query()).totals.totalTokens).toBe(505);
  });

  it('narrows to one ticket when asked', () => {
    ticket(1, 'K-1', 'One');
    ticket(2, 'K-2', 'Two');
    seed({ ticketId: 1, input: 5, output: 0 });
    seed({ ticketId: 2, input: 50, output: 0 });
    const stats = queryTokenUsageStats(store, query({ projectId: 1, ticketId: 2 }));
    expect(stats.totals.totalTokens).toBe(50);
    expect(stats.byTicket).toHaveLength(1);
  });

  it('paginates the ticket table and reports the full group count', () => {
    for (let i = 1; i <= 5; i++) {
      ticket(i, `K-${i}`, `T${i}`);
      seed({ ticketId: i, input: i * 10, output: 0 });
    }
    const stats = queryTokenUsageStats(store, query({ projectId: 1, limit: 2, offset: 1 }));
    expect(stats.byTicket.map((r) => r.ticketId)).toEqual([4, 3]);
    expect(stats.ticketGroups).toBe(5);
    // Totals cover the whole range, not just the page.
    expect(stats.totals.totalTokens).toBe(150);
  });

  it('rolls up in SQL — the group queries never read every row into memory', () => {
    ticket(1, 'K-1', 'One');
    for (let i = 0; i < 200; i++) seed({ input: 1, output: 0 });
    const plan = store.db
      .prepare(
        'EXPLAIN QUERY PLAN SELECT ticket_id, SUM(total_tokens) FROM token_usage WHERE project_id = ? AND recorded_at >= ? GROUP BY ticket_id',
      )
      .all(1, '2026-01-01')
      .map((r) => (r as { detail: string }).detail)
      .join(' ');
    expect(plan).toMatch(/USING INDEX idx_token_usage/);
  });
});

/**
 * v27 process-run attribution (§ task 3): a call made by an inside process
 * (gates, commit, delivery-receipt…) is linked to its process_runs row, so the
 * inside view can show one process's spend. Legacy rows — and rows whose caller
 * named no process — carry NULL and stay visible to every normal query.
 */
describe('process-run attribution', () => {
  function run(): { id: number } {
    return openProcessRun(store, {
      ticketId: 1,
      stageKey: 'review',
      processId: 'review',
      attempt: 0,
      startedAt: '2026-07-15T00:00:00.000Z',
    });
  }

  it('links a call to the process run that made it, and lists by that run', () => {
    ticket(1, 'K-1', 'One');
    const r = run();
    seed({ input: 120, output: 30, processRunId: r.id });
    seed({ input: 5, output: 5 });

    const linked = listTokenUsage(store, { ticketId: 1, processRunId: r.id });
    expect(linked).toHaveLength(1);
    expect(linked[0]!.processRunId).toBe(r.id);
    expect(linked[0]!.inputTokens).toBe(120);
    expect(linked[0]!.outputTokens).toBe(30);
    // The run's own row carries the ticket, so the linkage is navigable.
    expect(listTokenUsage(store, { processRunId: r.id })[0]!.ticketId).toBe(1);
  });

  it('summarizes only RECORDED usage — estimated rows are excluded', () => {
    ticket(1, 'K-1', 'One');
    const r = run();
    seed({ input: 120, output: 30, processRunId: r.id });
    seed({ input: 999, output: 999, estimated: true, processRunId: r.id });

    expect(summarizeRecordedTokenUsage(store, 1)).toEqual({ input: 120, output: 30, total: 150 });
  });

  it('counts a process\'s estimated calls separately from its measured total', () => {
    ticket(1, 'K-1', 'One');
    const r = run();
    seed({ input: 120, output: 30, processRunId: r.id });
    seed({ input: 500, output: 500, estimated: true, processRunId: r.id });

    // A measured total and an estimate count are different facts: the count
    // rides beside the total, and the estimate's tokens never enter it.
    expect(summarizeRecordedTokenUsageForProcess(store, 1, 'review')).toEqual({
      total: 150,
      estimatedCalls: 1,
    });
  });

  it('keeps legacy null-linked rows in normal ticket-level queries', () => {
    ticket(1, 'K-1', 'One');
    seed({ input: 40, output: 10 });

    const stats = queryTokenUsageStats(store, query({ projectId: 1, ticketId: 1 }));
    expect(stats.totals.totalTokens).toBe(50);

    const rows = listTokenUsage(store, { ticketId: 1 });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.processRunId).toBeNull();
    expect(rows[0]!.ticketId).toBe(1);
  });
});

describe('summarizeRecordedTokenUsageByRole', () => {
  function run(processId: string, stageKey: string): { id: number } {
    return openProcessRun(store, {
      ticketId: 1,
      stageKey: stageKey as never,
      processId,
      attempt: 0,
      startedAt: '2026-07-15T00:00:00.000Z',
    });
  }

  it('groups recorded spend by inside role in a fixed order', () => {
    ticket(1, 'K-1', 'One');
    const session = run('session', 'impl');
    const tester = run('tester', 'uat');
    const review = run('review', 'review');
    const fix = run('fix', 'fix');
    const prDesc = run('pr-description', 'ship');
    seed({ input: 100, output: 20, processRunId: session.id });
    seed({ input: 10, output: 5, processRunId: tester.id });
    seed({ input: 10, output: 5, processRunId: review.id });
    seed({ input: 2, output: 1, processRunId: fix.id });
    seed({ input: 5, output: 5, processRunId: prDesc.id });

    expect(summarizeRecordedTokenUsageByRole(store, 1)).toEqual([
      { role: 'implementation', input: 100, output: 20, total: 120 },
      { role: 'quality', input: 22, output: 11, total: 33 },
      { role: 'ship', input: 5, output: 5, total: 10 },
    ]);
  });

  it('excludes estimated rows and unattributed legacy rows', () => {
    ticket(1, 'K-1', 'One');
    const session = run('session', 'impl');
    seed({ input: 100, output: 20, processRunId: session.id });
    seed({ input: 999, output: 999, estimated: true, processRunId: session.id });
    seed({ input: 40, output: 10 });

    expect(summarizeRecordedTokenUsageByRole(store, 1)).toEqual([
      { role: 'implementation', input: 100, output: 20, total: 120 },
    ]);
  });

  it('omits roles with no recorded spend', () => {
    ticket(1, 'K-1', 'One');
    expect(summarizeRecordedTokenUsageByRole(store, 1)).toEqual([]);
  });
});
