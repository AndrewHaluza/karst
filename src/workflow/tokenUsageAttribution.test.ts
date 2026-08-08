import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { createTicketFlow } from './stages/create.js';
import { transition } from './machine.js';
import { runFix } from './stages/fix.js';
import { analyzeTicket } from './classify/analyze.js';
import { suggestSignals } from './classify/suggest.js';
import type { AgentAdapter, HeadlessResult, RunHeadlessOpts } from '../agent/adapter.js';
import { instrumentAdapter } from '../agent/instrumentedAdapter.js';
import { attachUsage } from '../agent/tokenUsage.js';
import { recordTokenUsage, queryTokenUsageStats } from '../store/tokenUsage.js';
import { listTokenUsage, summarizeRecordedTokenUsage } from '../store/tokenUsage.js';
import { openProcessRun } from '../store/processRuns.js';
import { parseUsageQuery } from '../store/tokenUsageQuery.js';

/**
 * End-to-end check of the instrumentation contract (§ token consumption stats):
 * a real AI-driven feature, run through the real wrapper against a real store,
 * must leave ONE row filed under the right call site and the right ticket — and
 * must behave exactly as it did before otherwise.
 */

let store: Store;

/** A core that reports counts in its envelope, the way `claude -p --json` does. */
function reportingAdapter(overrides: Partial<AgentAdapter> = {}): AgentAdapter {
  return {
    requiredBinary: 'fake',
    capabilities: { lifecycleEvents: true, resume: true },
    runHeadless: async (_opts: RunHeadlessOpts): Promise<HeadlessResult> => ({
      sessionId: 'sess-1',
      verdict: null,
      raw: '{"prompt":"do it","approach":"a","repos":[],"reason":"r","type":"feat"}',
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 5,
        cacheWriteTokens: 0,
        totalTokens: 125,
        model: 'claude-opus-5',
        estimated: false,
      },
    }),
    buildInteractiveCommand: () => ({ command: 'fake', args: [], env: {} }),
    ...overrides,
  };
}

function instrumented(inner: AgentAdapter, logError = vi.fn()): AgentAdapter {
  return instrumentAdapter(inner, {
    sink: { record: (entry) => recordTokenUsage(store, entry) },
    provider: 'claude',
    projectId: () => 1,
    logError,
    now: () => '2026-08-01T00:00:00.000Z',
  });
}

function rows(): {
  ticket_id: number | null;
  call_site: string;
  provider: string | null;
  model: string | null;
  total_tokens: number;
  outcome: string;
  project_id: number | null;
}[] {
  return store.db.prepare('SELECT * FROM token_usage ORDER BY id').all() as never;
}

beforeEach(() => {
  store = openStore(':memory:');
  store.db.prepare('INSERT INTO projects (id, slug) VALUES (?, ?)').run(1, 'karst');
});
afterEach(() => store.close());

describe('instrumented AI calls', () => {
  it('persists the fix-stage resume under its call site and ticket', async () => {
    const id = createTicketFlow(store, { key: 'T-1', title: 't' }).id;
    store.db.prepare('UPDATE tickets SET session_id = ?, project_id = 1 WHERE id = ?').run('s', id);
    transition(store, id, 'scope', { kind: 'passed' });
    transition(store, id, 'impl', { kind: 'passed' });
    transition(store, id, 'uat', { kind: 'failed', reason: 'boom' });

    const next = await runFix(store, { ticketId: id, cwd: '/wt' }, instrumented(reportingAdapter()));

    // The feature behaves exactly as before: a fix re-enters uat to revalidate.
    expect(next).toBe('uat');

    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({
      ticket_id: id,
      call_site: 'fix-resume',
      provider: 'claude',
      model: 'claude-opus-5',
      total_tokens: 125,
      outcome: 'ok',
      project_id: 1,
    });
  });

  it('persists the ticket analyzer’s spend, unattributed while the ticket is a draft', async () => {
    const analysis = await analyzeTicket(instrumented(reportingAdapter()), {
      brief: 'b',
      services: [],
      approaches: [{ id: 'a', label: 'A' } as never],
    });
    expect(analysis.approachId).toBe('a');

    expect(rows()).toHaveLength(1);
    expect(rows()[0]!.call_site).toBe('ticket-analysis');
    expect(rows()[0]!.ticket_id).toBeNull();
  });

  it('attributes the analyzer to the ticket once one exists', async () => {
    const id = createTicketFlow(store, { key: 'T-2', title: 't' }).id;
    await analyzeTicket(instrumented(reportingAdapter()), {
      brief: 'b',
      services: [],
      approaches: [],
      ticketId: id,
    });
    expect(rows()[0]!.ticket_id).toBe(id);
  });

  it('persists the signal suggestion under its own call site', async () => {
    await suggestSignals(
      instrumented(
        reportingAdapter({
          runHeadless: async () => ({ sessionId: '', verdict: null, raw: '["auth","login"]' }),
        }),
      ),
      { service: 'api', repoPath: '/repo' },
    );
    expect(rows()[0]!.call_site).toBe('signal-suggestion');
    // Nothing was reported, so the counts are a MARKED estimate.
    const estimated = store.db.prepare('SELECT estimated FROM token_usage').get() as {
      estimated: number;
    };
    expect(estimated.estimated).toBe(1);
  });

  it('keeps the counts of a call that failed after the provider reported them', async () => {
    const id = createTicketFlow(store, { key: 'T-3', title: 't' }).id;
    store.db.prepare('UPDATE tickets SET session_id = ? WHERE id = ?').run('s', id);
    transition(store, id, 'scope', { kind: 'passed' });
    transition(store, id, 'impl', { kind: 'passed' });
    transition(store, id, 'uat', { kind: 'failed', reason: 'boom' });

    const adapter = instrumented(
      reportingAdapter({
        runHeadless: async () => {
          throw attachUsage(new Error('Claude usage limit reached.'), {
            inputTokens: 900,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            totalTokens: 900,
            model: 'claude-opus-5',
            estimated: false,
          });
        },
      }),
    );

    await expect(runFix(store, { ticketId: id, cwd: '/wt' }, adapter)).rejects.toThrow(
      'usage limit',
    );
    expect(rows()[0]).toMatchObject({
      ticket_id: id,
      call_site: 'fix-resume',
      outcome: 'error',
      total_tokens: 900,
    });
  });

  it('never fails the AI feature when the ledger write fails', async () => {
    // Drop the table out from under the sink: the analyzer must still answer.
    store.db.exec('DROP TABLE token_usage');
    const logError = vi.fn();
    const analysis = await analyzeTicket(instrumented(reportingAdapter(), logError), {
      brief: 'b',
      services: [],
      approaches: [],
    });
    expect(analysis.prompt).toBe('do it');
    expect(logError).toHaveBeenCalledTimes(1);
  });

  it('rolls the recorded calls up into the stats the API exposes', async () => {
    const id = createTicketFlow(store, { key: 'T-4', title: 'Four' }).id;
    store.db.prepare('UPDATE tickets SET project_id = 1 WHERE id = ?').run(id);
    const adapter = instrumented(reportingAdapter());
    await analyzeTicket(adapter, { brief: 'b', services: [], approaches: [], ticketId: id });
    await analyzeTicket(adapter, { brief: 'b', services: [], approaches: [], ticketId: id });

    const parsed = parseUsageQuery({ projectId: 1 });
    if (!parsed.ok) throw new Error(parsed.error);
    const stats = queryTokenUsageStats(store, parsed.query);
    expect(stats.totals.calls).toBe(2);
    expect(stats.totals.totalTokens).toBe(250);
    expect(stats.byCallSite).toEqual([expect.objectContaining({ key: 'ticket-analysis' })]);
    expect(stats.byModel[0]!.key).toBe('claude-opus-5');
    expect(stats.byTicket[0]).toMatchObject({ ticketId: id, ticketKey: 'T-4', totalTokens: 250 });
  });

  it('attributes a call to the inside process run that made it, measured spend only', async () => {
    const id = createTicketFlow(store, { key: 'T-5', title: 'Five' }).id;
    store.db.prepare('UPDATE tickets SET project_id = 1 WHERE id = ?').run(id);
    const run = openProcessRun(store, {
      ticketId: id,
      stageKey: 'review',
      processId: 'review',
      attempt: 0,
      startedAt: '2026-08-01T00:00:00.000Z',
    });
    const adapter = instrumented(reportingAdapter());

    await adapter.runHeadless({
      prompt: 'do it',
      cwd: '/wt',
      tracking: { callSite: 'fix-resume', ticketId: id, processRunId: run.id },
    });
    // An estimated fallback call is recorded but is NOT recorded spend.
    store.db.prepare('UPDATE token_usage SET estimated = 1 WHERE process_run_id = ?').run(run.id);

    expect(listTokenUsage(store, { ticketId: id, processRunId: run.id })).toHaveLength(1);
    expect(listTokenUsage(store, { processRunId: run.id })[0]!.ticketId).toBe(id);
    expect(summarizeRecordedTokenUsage(store, id)).toEqual({ input: 0, output: 0, total: 0 });
  });
});
