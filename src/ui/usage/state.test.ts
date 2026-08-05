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
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: input + output,
      model: o.model === undefined ? 'claude-opus-5' : o.model,
      estimated: o.estimated ?? false,
    },
  });
}

/** A call whose spend is mostly cache traffic — the shape this view mis-ranked. */
function cacheSeed(o: {
  ticketId?: number;
  callSite?: string;
  cacheRead?: number;
  cacheWrite?: number;
}): void {
  const cacheRead = o.cacheRead ?? 0;
  const cacheWrite = o.cacheWrite ?? 0;
  recordTokenUsage(store, {
    projectId: 1,
    ticketId: o.ticketId ?? 1,
    callSite: o.callSite ?? 'ticket-analysis',
    provider: 'claude',
    outcome: 'ok',
    recordedAt: '2026-07-30T00:00:00.000Z',
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      totalTokens: cacheRead + cacheWrite,
      model: 'claude-opus-5',
      estimated: false,
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
    expect(state.byCallSite).toEqual([]);
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

  it('labels each call-site breakdown row and sizes its share of the total', () => {
    ticket(1, 'K-1', 'One');
    seed({ callSite: 'pr-description', input: 70, output: 0 });
    seed({ callSite: 'ticket-analysis', input: 30, output: 0 });
    const { byCallSite } = buildUsageState(store, { projectId: 1, now: NOW });
    expect(byCallSite.map((r) => [r.key, r.label, r.share])).toEqual([
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
    const rows = buildUsageState(store, { projectId: 1, now: NOW }).byCallSite;
    expect(rows.find((r) => r.key === 'fix-resume')!.estimated).toBe(true);
    expect(rows.find((r) => r.key === 'pr-description')!.estimated).toBe(false);
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

  it('ranks and sizes the breakdown on effective tokens, not on the raw sum', () => {
    ticket(1, 'K-1', 'One');
    // review-findings: one cache-heavy call. Biggest raw total, cheapest spend.
    cacheSeed({ callSite: 'review-findings', cacheRead: 1_000_000 });
    // ticket-analysis: smaller raw total, more expensive in input-equivalents.
    cacheSeed({ callSite: 'ticket-analysis', cacheWrite: 200_000 });
    const { byCallSite } = buildUsageState(store, { projectId: 1, now: NOW });
    expect(byCallSite.map((r) => r.key)).toEqual(['ticket-analysis', 'review-findings']);
    // Shares are of the EFFECTIVE total (250k + 100k), so the bars agree with
    // the order above instead of contradicting it.
    expect(byCallSite.map((r) => r.share)).toEqual([71.4, 28.6]);
  });

  it('carries the raw total beside the effective one so the weighting stays checkable', () => {
    ticket(1, 'K-1', 'One');
    cacheSeed({ callSite: 'pr-description', cacheRead: 1_000_000 });
    const state = buildUsageState(store, { projectId: 1, now: NOW });
    expect(state.totals.totalDisplay).toBe('1M');
    expect(state.totals.effectiveDisplay).toBe('100k');
    expect(state.totals.effectiveExact).toBe('100,000');
    const row = state.byCallSite[0]!;
    expect(row.totalDisplay).toBe('1M');
    expect(row.effectiveDisplay).toBe('100k');
    expect(row.effectiveExact).toBe('100,000');
    expect(state.tickets[0]!.effectiveDisplay).toBe('100k');
  });

  it('defaults to the effective sort and offers it as a labelled key', () => {
    const state = buildUsageState(store, { projectId: 1, now: NOW });
    expect(state.sort).toBe('effective');
    expect(state.sorts.find((s) => s.id === 'effective')!.label).toBe('Effective tokens');
  });

  it('sorts the ticket table by effective tokens when asked, unlike the raw total', () => {
    ticket(1, 'K-1', 'Cache heavy');
    ticket(2, 'K-2', 'Write heavy');
    cacheSeed({ ticketId: 1, cacheRead: 1_000_000 });
    cacheSeed({ ticketId: 2, cacheWrite: 200_000 });
    expect(
      buildUsageState(store, { projectId: 1, sort: 'total', now: NOW }).tickets.map(
        (t) => t.ticketId,
      ),
    ).toEqual([1, 2]);
    expect(
      buildUsageState(store, { projectId: 1, sort: 'effective', now: NOW }).tickets.map(
        (t) => t.ticketId,
      ),
    ).toEqual([2, 1]);
  });

  it('counts errored calls in the totals — the tokens were spent', () => {
    ticket(1, 'K-1', 'One');
    seed({ outcome: 'error', input: 40, output: 0 });
    const { totals } = buildUsageState(store, { projectId: 1, now: NOW });
    expect(totals.erroredCalls).toBe(1);
    expect(totals.totalExact).toBe('40');
  });
});
