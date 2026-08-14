import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { recordTokenUsage } from '../../store/tokenUsage.js';
import { buildUsageState } from './state.js';

let store: Store;

const NOW = (): Date => new Date('2026-08-01T12:00:00.000Z');

function ticket(id: number, key: string, title: string): void {
  store.db
    .prepare('INSERT INTO tickets (id, key, title, project_id) VALUES (?, ?, ?, 1)')
    .run(id, key, title);
}

function seed(o: {
  ticketId?: number | null;
  callSite?: string;
  model?: string | null;
  input?: number;
  output?: number;
  estimated?: boolean;
  outcome?: 'ok' | 'error';
  at?: string;
}): void {
  const input = o.input ?? 10;
  const output = o.output ?? 5;
  recordTokenUsage(store, {
    projectId: 1,
    ticketId: o.ticketId === undefined ? 1 : o.ticketId,
    callSite: o.callSite ?? 'ticket-analysis',
    provider: 'claude',
    outcome: o.outcome ?? 'ok',
    recordedAt: o.at ?? '2026-07-30T00:00:00.000Z',
    usage: {
      inputTokens: input,
      outputTokens: output,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: input + output,
      model: o.model === undefined ? 'claude-opus-5' : o.model,
      estimated: o.estimated ?? false,
    },
  });
}

beforeEach(() => {
  store = openStore(':memory:');
  store.db.prepare('INSERT INTO projects (id, slug) VALUES (1, ?)').run('karst');
});
afterEach(() => store.close());

describe('buildUsageState', () => {
  it('reports the empty state gracefully, with the filters still usable', () => {
    const state = buildUsageState(store, { projectId: 1, now: NOW });
    expect(state.empty).toBe(true);
    expect(state.error).toBeNull();
    expect(state.totals.totalDisplay).toBe('0');
    expect(state.byStage).toEqual([]);
    expect(state.byModel).toEqual([]);
    expect(state.tickets).toEqual([]);
    // The filters are part of the empty state — the user must be able to widen
    // the range without first having data in the one they landed on.
    expect(state.ranges.map((r) => r.id)).toEqual(['24h', '7d', '30d', 'all']);
    expect(state.sorts.length).toBeGreaterThan(0);
  });

  it('renders overall totals as formatted strings, not raw numbers', () => {
    ticket(1, 'K-1', 'One');
    seed({ input: 1_200_000, output: 4_300 });
    const state = buildUsageState(store, { projectId: 1, now: NOW });
    expect(state.empty).toBe(false);
    expect(state.totals.calls).toBe(1);
    expect(state.totals.inputDisplay).toBe('1.2M');
    expect(state.totals.outputDisplay).toBe('4.3k');
    expect(state.totals.totalExact).toBe('1,204,300');
  });

  it('labels each stage breakdown row and sizes its share of the total', () => {
    ticket(1, 'K-1', 'One');
    seed({ callSite: 'pr-description', input: 70, output: 0 });
    seed({ callSite: 'ticket-analysis', input: 30, output: 0 });
    const { byStage } = buildUsageState(store, { projectId: 1, now: NOW });
    expect(byStage.map((r) => [r.key, r.label, r.share])).toEqual([
      ['pr-description', 'PR description', 70],
      ['ticket-analysis', 'Ticket analysis', 30],
    ]);
  });

  it('names an unreported model instead of showing a blank row', () => {
    ticket(1, 'K-1', 'One');
    seed({ model: null });
    expect(buildUsageState(store, { projectId: 1, now: NOW }).byModel[0]!.label).toBe('unreported');
  });

  it('flags a group whose every call was estimated', () => {
    ticket(1, 'K-1', 'One');
    seed({ callSite: 'fix-resume', estimated: true });
    seed({ callSite: 'pr-description', estimated: false });
    const byStage = buildUsageState(store, { projectId: 1, now: NOW }).byStage;
    expect(byStage.find((r) => r.key === 'fix-resume')!.estimated).toBe(true);
    expect(byStage.find((r) => r.key === 'pr-description')!.estimated).toBe(false);
  });

  it('labels ticket rows, including the unattributed one', () => {
    ticket(1, 'K-1', 'One');
    seed({ ticketId: 1, input: 100, output: 0 });
    seed({ ticketId: null, input: 5, output: 0 });
    const { tickets } = buildUsageState(store, { projectId: 1, now: NOW });
    expect(tickets.map((t) => t.label)).toEqual(['K-1 — One', 'Not attributed to a ticket']);
  });

  it('sorts the ticket table by the requested key', () => {
    ticket(1, 'K-1', 'One');
    ticket(2, 'K-2', 'Two');
    seed({ ticketId: 1, input: 1, output: 90 });
    seed({ ticketId: 2, input: 90, output: 1 });
    expect(
      buildUsageState(store, { projectId: 1, sort: 'input', now: NOW }).tickets.map(
        (t) => t.ticketId,
      ),
    ).toEqual([2, 1]);
    expect(
      buildUsageState(store, { projectId: 1, sort: 'output', now: NOW }).tickets.map(
        (t) => t.ticketId,
      ),
    ).toEqual([1, 2]);
  });

  it('cuts on the selected time range', () => {
    ticket(1, 'K-1', 'One');
    seed({ at: '2026-08-01T06:00:00.000Z', input: 3, output: 0 });
    seed({ at: '2026-06-01T00:00:00.000Z', input: 900, output: 0 });
    expect(buildUsageState(store, { projectId: 1, rangeId: '24h', now: NOW }).totals.totalExact).toBe(
      '3',
    );
    expect(buildUsageState(store, { projectId: 1, rangeId: 'all', now: NOW }).totals.totalExact).toBe(
      '903',
    );
  });

  it('scopes to the bound project — another window’s spend is not shown', () => {
    ticket(1, 'K-1', 'One');
    seed({ input: 5, output: 0 });
    recordTokenUsage(store, {
      projectId: 2,
      ticketId: null,
      callSite: 'pr-description',
      outcome: 'ok',
      recordedAt: '2026-07-30T00:00:00.000Z',
      usage: {
        inputTokens: 900,
        outputTokens: 0,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 900,
        model: null,
        estimated: false,
      },
    });
    expect(buildUsageState(store, { projectId: 1, now: NOW }).totals.totalExact).toBe('5');
  });

  it('reports paging state so the view can page without a second query', () => {
    for (let i = 1; i <= 4; i++) {
      ticket(i, `K-${i}`, `T${i}`);
      seed({ ticketId: i, input: i * 10, output: 0 });
    }
    const first = buildUsageState(store, { projectId: 1, limit: 2, now: NOW });
    expect(first.tickets.map((t) => t.ticketId)).toEqual([4, 3]);
    expect(first.page).toMatchObject({ offset: 0, groups: 4, hasPrev: false, hasNext: true });

    const second = buildUsageState(store, { projectId: 1, limit: 2, offset: 2, now: NOW });
    expect(second.tickets.map((t) => t.ticketId)).toEqual([2, 1]);
    expect(second.page).toMatchObject({ hasPrev: true, hasNext: false });
  });

  it('states a rejected query instead of rendering it as zero spend', () => {
    const state = buildUsageState(store, { projectId: 1, limit: 10_000, now: NOW });
    expect(state.error).toMatch(/limit/);
    expect(state.empty).toBe(true);
    expect(state.tickets).toEqual([]);
  });

  it('counts errored calls in the totals — the tokens were spent', () => {
    ticket(1, 'K-1', 'One');
    seed({ outcome: 'error', input: 40, output: 0 });
    const { totals } = buildUsageState(store, { projectId: 1, now: NOW });
    expect(totals.erroredCalls).toBe(1);
    expect(totals.totalExact).toBe('40');
  });

  describe('graph spend by profile (Slice-6 T2)', () => {
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

    function nodeRun(id: number, profile: string | null): void {
      store.db
        .prepare(
          `INSERT INTO approach_node_runs
             (id, graph_run_id, revision_id, node_id, node_kind, visit_number, status, profile)
           VALUES (?, 1, 1, ?, 'agent', 1, 'completed', ?)`,
        )
        .run(id, `n${id}`, profile);
    }

    function graphSeed(o: { nodeRunId: number; input: number; output: number }): void {
      recordTokenUsage(store, {
        projectId: 1,
        ticketId: 1,
        approachNodeRunId: o.nodeRunId,
        callSite: 'graph-node',
        provider: 'codex',
        outcome: 'ok',
        recordedAt: T,
        usage: {
          inputTokens: o.input,
          outputTokens: o.output,
          reasoningTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: o.input + o.output,
          model: 'sol',
          estimated: false,
        },
      });
    }

    it('breaks graph spend down per profile through the run join', () => {
      graphTicket();
      nodeRun(9, 'graphite');
      nodeRun(10, 'graphite');
      graphSeed({ nodeRunId: 9, input: 40, output: 10 });
      graphSeed({ nodeRunId: 10, input: 5, output: 5 });
      const { byProfile, totals } = buildUsageState(store, { projectId: 1, now: NOW });
      expect(totals.totalExact).toBe('60');
      expect(byProfile).toHaveLength(1);
      expect(byProfile[0]).toMatchObject({
        label: 'graphite',
        calls: 2,
        totalExact: '60',
        share: 100,
        provider: 'codex',
      });
    });

    it('renders an unresolved profile as unknown, never as a zero', () => {
      graphTicket();
      nodeRun(9, null);
      graphSeed({ nodeRunId: 9, input: 40, output: 10 });
      const { byProfile } = buildUsageState(store, { projectId: 1, now: NOW });
      expect(byProfile).toHaveLength(1);
      // The run never resolved a profile — the row is NAMED, never blank and
      // never a "0" that could read as a profile called zero.
      expect(byProfile[0]!.label).toBe('unknown profile');
      expect(byProfile[0]!.key).toBe('');
      // Its recorded spend is shown as recorded — a fabricated 0 is the one
      // wrong answer this view must never give.
      expect(byProfile[0]!.totalExact).toBe('50');
      expect(byProfile[0]!.totalDisplay).toBe('50');
    });

    it('a rejected query leaves the graph breakdown empty — never a table reading as zero spend', () => {
      graphTicket();
      nodeRun(9, 'graphite');
      graphSeed({ nodeRunId: 9, input: 40, output: 10 });
      const state = buildUsageState(store, { projectId: 1, limit: 10_000, now: NOW });
      expect(state.error).toMatch(/limit/);
      expect(state.byProfile).toEqual([]);
      expect(state.empty).toBe(true);
      expect(state.totals.totalDisplay).toBe('0');
    });
  });
});

describe('usage totals — fresh spend and reasoning', () => {
  it('headlines FRESH tokens and states cache reads and reasoning separately', () => {
    // A cached opencode session: 3.7M of the raw tally was the same context
    // re-read from the prompt cache and must not present as conversation.
    ticket(1, 'K-1', 'One');
    recordTokenUsage(store, {
      projectId: 1,
      ticketId: 1,
      callSite: 'implementation',
      provider: 'opencode',
      outcome: 'ok',
      recordedAt: '2026-07-30T00:00:00.000Z',
      usage: {
        inputTokens: 215_929,
        outputTokens: 4_114,
        reasoningTokens: 40_485,
        cacheReadTokens: 3_704_064,
        cacheWriteTokens: 0,
        totalTokens: 3_964_592,
        model: null,
        estimated: false,
      },
    });
    const totals = buildUsageState(store, { projectId: 1, now: NOW }).totals;
    expect(totals.totalDisplay).toBe('260.5k');
    expect(totals.totalExact).toBe('260,528');
    expect(totals.cacheReadDisplay).toBe('3.7M');
    expect(totals.reasoningDisplay).toBe('40.5k');
  });
});
