import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from './db.js';
import {
  recordTokenUsage,
  queryTokenUsageStats,
  listTokenUsage,
  summarizeRecordedTokenUsage,
  summarizeRecordedTokenUsageForProcess,
  summarizeRecordedTokenUsageByRole,
  listRecentlyUsedModels,
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
  projectId?: number | null;
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
    projectId: s.projectId === undefined ? 1 : s.projectId,
    ticketId: s.ticketId === undefined ? 1 : s.ticketId,
    processRunId: s.processRunId === undefined ? null : s.processRunId,
    callSite: s.callSite ?? 'ticket-analysis',
    provider: s.provider ?? 'claude',
    outcome: s.outcome ?? 'ok',
    recordedAt: s.at ?? '2026-07-15T00:00:00.000Z',
    usage: {
      inputTokens: input,
      outputTokens: output,
      reasoningTokens: 0,
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
        reasoningTokens: 0,
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
        reasoningTokens: 0,
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
      reasoningTokens: 0,
      cacheReadTokens: 100,
      cacheWriteTokens: 3,
      totalTokens: 145,
      // The raw tally less the 100 cache reads — what every headline, ORDER BY
      // and share denominator uses.
      freshTokens: 45,
      estimatedCalls: 0,
      erroredCalls: 0,
    });
  });

  it('sorts and pages the ticket table on FRESH spend, matching what it displays', () => {
    // The cache-heavy ticket has the bigger RAW tally (3.9M vs 300k) but far
    // less fresh spend. Ordering on the raw total put it first while the table
    // rendered fresh figures that said otherwise — and with a LIMIT it could
    // page the genuinely expensive ticket off the end.
    ticket(1, 'K-1', 'Cache heavy');
    ticket(2, 'K-2', 'Fresh heavy');
    seed({ ticketId: 1, input: 200_000, output: 4_000, cacheRead: 3_700_000 });
    seed({ ticketId: 2, input: 250_000, output: 50_000, cacheRead: 0 });

    const { byTicket } = queryTokenUsageStats(store, query({ projectId: 1, sort: 'total' }));
    expect(byTicket.map((r) => r.ticketKey)).toEqual(['K-2', 'K-1']);
    expect(byTicket[0]!.freshTokens).toBe(300_000);
    expect(byTicket[1]!.freshTokens).toBe(204_000);
    // The raw tally is still recorded faithfully — only the ordering changed.
    expect(byTicket[1]!.totalTokens).toBe(3_904_000);

    const firstPage = queryTokenUsageStats(
      store,
      query({ projectId: 1, sort: 'total', limit: 1, offset: 0 }),
    );
    expect(firstPage.byTicket.map((r) => r.ticketKey)).toEqual(['K-2']);
  });

  it('orders breakdown rows on fresh spend too, so the order matches the numbers', () => {
    ticket(1, 'K-1', 'One');
    seed({ callSite: 'implementation', input: 1_000, output: 100, cacheRead: 900_000 });
    seed({ callSite: 'uat-tester', input: 5_000, output: 5_000, cacheRead: 0 });

    const { byCallSite } = queryTokenUsageStats(store, query({ projectId: 1 }));
    expect(byCallSite.map((r) => r.key)).toEqual(['uat-tester', 'implementation']);
  });

  it('never reports a negative fresh total when reads exceed a legacy row\'s tally', () => {
    ticket(1, 'K-1', 'One');
    // A pre-split row: cache reads recorded, but a total that never counted them.
    recordTokenUsage(store, {
      projectId: 1,
      ticketId: 1,
      callSite: 'implementation',
      provider: 'opencode',
      outcome: 'ok',
      recordedAt: '2026-07-15T00:00:00.000Z',
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        reasoningTokens: 0,
        cacheReadTokens: 900,
        cacheWriteTokens: 0,
        totalTokens: 15,
        model: null,
        estimated: false,
      },
    });
    expect(queryTokenUsageStats(store, query({ projectId: 1 })).totals.freshTokens).toBe(0);
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
        reasoningTokens: 0,
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
 * Slice-6 T2: graph spend rolled up PER PROFILE through the node/planner run
 * join. The resolved profile is recorded on the RUN row (`approach_node_runs
 * .profile` / `approach_planner_runs.profile`), never on `token_usage` — so the
 * rollup is a JOIN, not a new column. Aggregation stays a SQL GROUP BY off the
 * existing indexes (`idx_token_usage_*` + the run tables' PKs), never an
 * in-memory rollup.
 */
describe('graph-run per-profile rollup (Slice-6 T2)', () => {
  const T = '2026-08-12T00:00:00.000Z';

  function graphTicket(): void {
    ticket(1, 'K-1', 'One');
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
  }

  function nodeRun(id: number, profile: string | null, provider: string | null): void {
    store.db
      .prepare(
        `INSERT INTO approach_node_runs
           (id, graph_run_id, revision_id, node_id, node_kind, visit_number, status, profile, provider)
         VALUES (?, 1, 1, ?, 'agent', 1, 'completed', ?, ?)`,
      )
      .run(id, `n${id}`, profile, provider);
  }

  function plannerRun(id: number, profile: string | null, provider: string | null): void {
    store.db
      .prepare(
        `INSERT INTO approach_planner_runs
           (id, graph_run_id, planner_run_number, kind, status, profile, provider)
         VALUES (?, 1, ?, 'bootstrap', 'submitted', ?, ?)`,
      )
      .run(id, id, profile, provider);
  }

  function graphSeed(o: {
    nodeRunId?: number;
    plannerRunId?: number;
    provider?: string;
    input?: number;
    output?: number;
    estimated?: boolean;
  }): void {
    recordTokenUsage(store, {
      projectId: 1,
      ticketId: 1,
      approachPlannerRunId: o.plannerRunId ?? null,
      approachNodeRunId: o.nodeRunId ?? null,
      callSite: o.nodeRunId !== undefined ? 'graph-node' : 'graph-planner',
      provider: o.provider ?? 'codex',
      outcome: 'ok',
      recordedAt: T,
      usage: {
        inputTokens: o.input ?? 40,
        outputTokens: o.output ?? 10,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: (o.input ?? 40) + (o.output ?? 10),
        model: 'sol',
        estimated: o.estimated ?? false,
      },
    });
  }

  it('rolls a graph run\'s spend up per profile through the node/planner join', () => {
    graphTicket();
    nodeRun(9, 'graphite', 'codex');
    nodeRun(10, 'graphite', 'codex');
    plannerRun(3, 'planner', 'claude');
    graphSeed({ nodeRunId: 9, input: 40, output: 10, provider: 'codex' });
    graphSeed({ nodeRunId: 10, input: 5, output: 5, provider: 'codex' });
    graphSeed({ plannerRunId: 3, input: 100, output: 20, provider: 'claude' });

    const { byProfile, totals } = queryTokenUsageStats(store, query({ projectId: 1 }));
    expect(totals.totalTokens).toBe(180);
    expect(
      byProfile.map((r) => [r.profile, r.provider, r.calls, r.inputTokens, r.outputTokens, r.totalTokens, r.estimatedCalls]),
    ).toEqual([
      ['planner', 'claude', 1, 100, 20, 120, 0],
      ['graphite', 'codex', 2, 45, 15, 60, 0],
    ]);
  });

  it('keeps a run that never resolved a profile under the unknown (empty) key', () => {
    graphTicket();
    nodeRun(9, null, 'codex');
    graphSeed({ nodeRunId: 9, input: 40, output: 10, provider: 'codex' });
    const { byProfile } = queryTokenUsageStats(store, query({ projectId: 1 }));
    expect(byProfile).toHaveLength(1);
    expect(byProfile[0]!.profile).toBe('');
    expect(byProfile[0]!.provider).toBe('codex');
    expect(byProfile[0]!.calls).toBe(1);
    expect(byProfile[0]!.totalTokens).toBe(50);
  });

  it('excludes spend outside the graph runtime from the profile rollup', () => {
    graphTicket();
    nodeRun(9, 'graphite', 'codex');
    graphSeed({ nodeRunId: 9, input: 40, output: 10, provider: 'codex' });
    seed({ input: 7, output: 0 });
    const { byProfile, totals } = queryTokenUsageStats(store, query({ projectId: 1 }));
    expect(totals.totalTokens).toBe(57);
    expect(byProfile).toEqual([
      expect.objectContaining({ profile: 'graphite', provider: 'codex', calls: 1, totalTokens: 50 }),
    ]);
  });

  it('rolls the profile grouping up in SQL — the query never reads rows into memory', () => {
    graphTicket();
    nodeRun(9, 'graphite', 'codex');
    graphSeed({ nodeRunId: 9, input: 40, output: 10, provider: 'codex' });
    const plan = store.db
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT COALESCE(nr.profile, pr.profile, '') AS profile, t.provider AS provider,
                COUNT(*) AS calls, COALESCE(SUM(t.total_tokens), 0) AS total_tokens
           FROM token_usage t
           LEFT JOIN approach_node_runs nr ON nr.id = t.approach_node_run_id
           LEFT JOIN approach_planner_runs pr ON pr.id = t.approach_planner_run_id
          WHERE (t.approach_node_run_id IS NOT NULL OR t.approach_planner_run_id IS NOT NULL)
            AND t.project_id = ? AND t.recorded_at >= ?
          GROUP BY COALESCE(nr.profile, pr.profile, ''), t.provider`,
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

    expect(summarizeRecordedTokenUsage(store, 1)).toEqual({
      input: 120,
      output: 30,
      total: 150,
      cacheRead: 0,
    });
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
      cacheRead: 0,
      estimatedCalls: 1,
    });
  });

  it('carries measured cache reads beside the total, so the display can headline fresh spend', () => {
    ticket(1, 'K-1', 'One');
    const r = run();
    recordTokenUsage(store, {
      projectId: null,
      ticketId: 1,
      processRunId: r.id,
      callSite: 'implementation',
      provider: 'opencode',
      outcome: 'ok',
      usage: {
        inputTokens: 215_929,
        outputTokens: 4_114,
        reasoningTokens: 0,
        cacheReadTokens: 3_704_064,
        cacheWriteTokens: 0,
        totalTokens: 3_924_107,
        model: null,
        estimated: false,
      },
    });
    expect(summarizeRecordedTokenUsageForProcess(store, 1, 'review')).toEqual({
      total: 3_924_107,
      cacheRead: 3_704_064,
      estimatedCalls: 0,
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

describe('listRecentlyUsedModels', () => {
  it('returns the most recently used models per provider, newest first', () => {
    ticket(1, 'K-1', 'One');
    seed({ provider: 'claude', model: 'claude-opus-5', at: '2026-07-01T00:00:00.000Z' });
    seed({ provider: 'claude', model: 'claude-sonnet-5', at: '2026-07-03T00:00:00.000Z' });
    seed({ provider: 'codex', model: 'gpt-5.6-sol', at: '2026-07-02T00:00:00.000Z' });
    seed({ provider: 'claude', model: 'claude-opus-5', at: '2026-07-04T00:00:00.000Z' });

    expect(listRecentlyUsedModels(store, 1)).toEqual({
      claude: ['claude-opus-5', 'claude-sonnet-5'],
      codex: ['gpt-5.6-sol'],
    });
  });

  it('caps each provider at the limit, keeping the newest', () => {
    ticket(1, 'K-1', 'One');
    seed({ provider: 'claude', model: 'm-1', at: '2026-07-01T00:00:00.000Z' });
    seed({ provider: 'claude', model: 'm-2', at: '2026-07-02T00:00:00.000Z' });
    seed({ provider: 'claude', model: 'm-3', at: '2026-07-03T00:00:00.000Z' });
    seed({ provider: 'claude', model: 'm-4', at: '2026-07-04T00:00:00.000Z' });
    seed({ provider: 'claude', model: 'm-5', at: '2026-07-05T00:00:00.000Z' });
    seed({ provider: 'claude', model: 'm-6', at: '2026-07-06T00:00:00.000Z' });

    expect(listRecentlyUsedModels(store, 1, 3)).toEqual({ claude: ['m-6', 'm-5', 'm-4'] });
  });

  it('is scoped by project', () => {
    ticket(1, 'K-1', 'One');
    ticket(2, 'K-2', 'Two', 2);
    seed({ provider: 'claude', model: 'claude-opus-5', at: '2026-07-01T00:00:00.000Z' });
    seed({ ticketId: 2, projectId: 2, provider: 'codex', model: 'gpt-5.6-sol', at: '2026-07-02T00:00:00.000Z' });

    expect(listRecentlyUsedModels(store, 1)).toEqual({ claude: ['claude-opus-5'] });
    expect(listRecentlyUsedModels(store, 2)).toEqual({ codex: ['gpt-5.6-sol'] });
  });

  it('skips rows whose core never named a model or provider', () => {
    ticket(1, 'K-1', 'One');
    seed({ provider: 'claude', model: null, at: '2026-07-01T00:00:00.000Z' });
    seed({ provider: 'claude', model: 'claude-opus-5', at: '2026-07-02T00:00:00.000Z' });

    expect(listRecentlyUsedModels(store, 1)).toEqual({ claude: ['claude-opus-5'] });
  });

  it('returns an empty map when nothing has been used', () => {
    ticket(1, 'K-1', 'One');
    expect(listRecentlyUsedModels(store, 1)).toEqual({});
  });
});
