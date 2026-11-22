import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { recordTokenUsage } from '../../store/tokenUsage.js';
import { buildUsageState, usageErrorState } from './state.js';
import type { QuotaSnapshot } from '../../agent/quota/types.js';

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
  provider?: string;
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
    provider: o.provider ?? 'claude',
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
    expect(state.byActivity).toEqual([]);
    expect(state.byModel).toEqual([]);
    expect(state.tickets).toEqual([]);
    expect(state.sorts.length).toBeGreaterThan(0);
    expect(state.page.summary).toBe('No tickets');
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
    const { byActivity } = buildUsageState(store, { projectId: 1, now: NOW });
    expect(byActivity.map((r) => [r.key, r.label, r.share])).toEqual([
      ['pr-description', 'PR description', 70],
      ['ticket-analysis', 'Ticket classify', 30],
    ]);
  });

  it('prints each call count with the shared plural helper', () => {
    ticket(1, 'K-1', 'One');
    seed({ callSite: 'pr-description' });
    const one = buildUsageState(store, { projectId: 1, now: NOW });
    expect(one.byActivity[0]!.callsText).toBe('1 call');
    seed({ callSite: 'pr-description' });
    const two = buildUsageState(store, { projectId: 1, now: NOW });
    expect(two.byActivity[0]!.callsText).toBe('2 calls');
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
    const byActivity = buildUsageState(store, { projectId: 1, now: NOW }).byActivity;
    expect(byActivity.find((r) => r.key === 'fix-resume')!.estimated).toBe(true);
    expect(byActivity.find((r) => r.key === 'pr-description')!.estimated).toBe(false);
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

  it('queries all-time consumption by default across historical dates', () => {
    ticket(1, 'K-1', 'One');
    seed({ at: '2026-08-01T06:00:00.000Z', input: 3, output: 0 });
    seed({ at: '2026-06-01T00:00:00.000Z', input: 900, output: 0 });
    expect(buildUsageState(store, { projectId: 1, now: NOW }).totals.totalExact).toBe(
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
    expect(first.page).toMatchObject({ offset: 0, groups: 4, hasPrev: false, hasNext: true, summary: '1–2 of 4 tickets' });

    const second = buildUsageState(store, { projectId: 1, limit: 2, offset: 2, now: NOW });
    expect(second.tickets.map((t) => t.ticketId)).toEqual([2, 1]);
    expect(second.page).toMatchObject({ hasPrev: true, hasNext: false, summary: '3–4 of 4 tickets' });

    const single = buildUsageState(store, { projectId: 1, limit: 4, now: NOW });
    expect(single.page.summary).toBe('1–4 of 4 tickets');
  });

  it('states a rejected query instead of rendering it as zero spend', () => {
    const state = buildUsageState(store, { projectId: 1, limit: 10_000, now: NOW });
    expect(state.error).toMatch(/limit/);
    expect(state.empty).toBe(true);
    expect(state.tickets).toEqual([]);
    expect(state.page.summary).toBe('No tickets');
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

describe('usage state quota rows', () => {
  it('maps quota snapshots for probed cores without an opencode2 row', () => {
    const snapshots: QuotaSnapshot[] = [
      { core: 'claude', state: 'unknown', reason: 'no source' },
      { core: 'codex', state: 'unknown', reason: 'no source' },
      { core: 'antigravity', state: 'unknown', reason: 'no source' },
      { core: 'opencode', state: 'unknown', reason: 'no source' },
    ];
    const state = buildUsageState(store, { projectId: 1, quota: snapshots, now: NOW });
    expect(state.quota.rows.map((r) => r.core)).toEqual(['claude', 'codex', 'antigravity', 'opencode']);
    expect(state.quota.rows.find((r) => r.core === 'opencode2')).toBeUndefined();
  });
});

const DATE_OPTS = { locale: 'en-US', timeZone: 'UTC' } as const;

describe('usage state — scope, labels and counts (US-1, US-4, US-5, US-7, US-11, US-17, US-35)', () => {
  it('labels all-time totals with the first recorded instant, and only "All time" when empty', () => {
    ticket(1, 'K-1', 'One');
    seed({ at: '2026-06-01T00:00:00.000Z', input: 5, output: 0 });
    seed({ at: '2026-07-30T00:00:00.000Z', input: 7, output: 0 });
    const state = buildUsageState(store, { projectId: 1, now: NOW, dateOptions: DATE_OPTS });
    expect(state.scopeLabel).toBe('All time · since Jun 1, 2026');
    expect(state.costNote).toBe('Tokens, not cost');
    expect(state.updatedLabel).toBe('Updated 12:00');
    expect(buildUsageState(store, { projectId: 1, now: NOW, dateOptions: DATE_OPTS, sort: 'calls' }).scopeLabel)
      .toBe('All time · since Jun 1, 2026');

    const empty = openStore(':memory:');
    try {
      empty.db.prepare('INSERT INTO projects (id, slug) VALUES (1, ?)').run('karst');
      expect(buildUsageState(empty, { projectId: 1, now: NOW, dateOptions: DATE_OPTS }).scopeLabel).toBe('All time');
    } finally {
      empty.close();
    }
  });

  it('builds a by-agent-core breakdown and names an unreported core', () => {
    ticket(1, 'K-1', 'One');
    seed({ provider: 'claude', input: 30, output: 0 });
    seed({ provider: 'codex', input: 70, output: 0 });
    recordTokenUsage(store, {
      projectId: 1,
      ticketId: null,
      callSite: 'pr-description',
      provider: null,
      outcome: 'ok',
      recordedAt: '2026-07-30T00:00:00.000Z',
      usage: {
        inputTokens: 10, outputTokens: 0, reasoningTokens: 0,
        cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 10,
        model: null, estimated: false,
      },
    });
    const { byProvider, counts } = buildUsageState(store, { projectId: 1, now: NOW });
    expect(byProvider.map((r) => [r.label, r.totalTokens, r.shareDisplay])).toEqual([
      ['Codex', 70, '63.6%'],
      ['Claude Code', 30, '27.3%'],
      ['Core not reported', 10, '9.1%'],
    ]);
    expect(counts.providers).toBe('3 agent cores');
  });

  it('renames the activity breakdown and explains the undeclared row (US-5)', () => {
    ticket(1, 'K-1', 'One');
    seed({ callSite: 'unknown', input: 10, output: 0 });
    const row = buildUsageState(store, { projectId: 1, now: NOW }).byActivity[0]!;
    expect(row.label).toBe('Undeclared');
    expect(row.title).toBe('The call site did not declare an activity');
  });

  it('caps a breakdown at six rows plus one Other row carrying the rest (US-23)', () => {
    ticket(1, 'K-1', 'One');
    for (let i = 1; i <= 10; i++) seed({ model: `model-${i}`, input: 100 * i, output: 0 });
    const { byModel, counts } = buildUsageState(store, { projectId: 1, now: NOW });
    expect(byModel).toHaveLength(7);
    expect(byModel[6]).toMatchObject({ key: '__other__', label: 'Other (4)', totalTokens: 100 + 200 + 300 + 400 });
    expect(counts.models).toBe('10 models');
    // The count is the true group count, not the seven drawn rows (UI-R31).
    expect(counts.modelCount).toBe(10);
    const shares = byModel.reduce((sum, row) => sum + row.share, 0);
    expect(Math.abs(shares - 100)).toBeLessThan(0.5);
  });

  it('prints a vanishing share as <0.1% instead of 0% (US-18)', () => {
    ticket(1, 'K-1', 'One');
    seed({ callSite: 'pr-description', input: 1, output: 0 });
    seed({ callSite: 'ticket-analysis', input: 99_999, output: 0 });
    const tiny = buildUsageState(store, { projectId: 1, now: NOW }).byActivity.find((r) => r.key === 'pr-description')!;
    expect(tiny.shareDisplay).toBe('<0.1%');
  });

  it('builds the estimated note and the errored note host-side', () => {
    ticket(1, 'K-1', 'One');
    seed({ estimated: true });
    seed({ estimated: false });
    seed({ outcome: 'error' });
    const { totals } = buildUsageState(store, { projectId: 1, now: NOW });
    expect(totals.estimatedNote).toBe('1 of 3 calls estimated');
    expect(totals.erroredNote).toBe('1 failed');
    expect(totals.totalNote).toBe('45 tokens');
  });

  it('splits the ticket key from its title and formats the last call (US-16, US-35)', () => {
    ticket(1, 'K-1', 'One');
    seed({ at: '2026-07-30T00:00:00.000Z', input: 10, output: 0 });
    const row = buildUsageState(store, { projectId: 1, now: NOW, dateOptions: DATE_OPTS }).tickets[0]!;
    expect(row.ticketKey).toBe('K-1');
    expect(row.ticketTitle).toBe('One');
    expect(row.label).toBe('K-1 — One');
    expect(row.lastDisplay).toBe('Jul 30');
    expect(row.lastTitle).toContain('Jul 30, 2026');
  });

  it('builds one accessible count per panel', () => {
    ticket(1, 'K-1', 'One');
    seed({ input: 10, output: 0 });
    const { counts } = buildUsageState(store, { projectId: 1, now: NOW });
    expect(counts).toEqual({
      providers: '1 agent core',
      activities: '1 activity',
      models: '1 model',
      profiles: '0 profiles',
      tickets: '1 ticket',
      providerCount: 1,
      activityCount: 1,
      modelCount: 1,
      profileCount: 0,
    });
  });

  it('usageErrorState states the failure without reading the store or quota (US-2)', () => {
    const state = usageErrorState(
      { tab: 'quota', sort: 'calls', offset: 0, limit: 20 },
      'Could not read token usage. Details are in the Karst log.',
      NOW(),
      DATE_OPTS,
    );
    expect(state.error).toBe('Could not read token usage. Details are in the Karst log.');
    expect(state.empty).toBe(true);
    expect(state.tab).toBe('quota');
    expect(state.sort).toBe('calls');
    expect(state.byProvider).toEqual([]);
    expect(state.byActivity).toEqual([]);
    expect(state.quota.rows).toEqual([]);
    expect(state.quota.subtitle).toBe('Warn at 80% used');
    expect(state.scopeLabel).toBe('All time');
    expect(state.updatedLabel).toBe('Updated 12:00');
  });
});
