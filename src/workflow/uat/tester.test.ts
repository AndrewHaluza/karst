import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { createTicketFlow } from '../stages/create.js';
import { transition } from '../machine.js';
import { listProcessRuns, openProcessRun } from '../../store/processRuns.js';
import { listUatFindings } from '../../store/uatFindings.js';
import {
  buildTesterPrompt,
  runUatTester,
  type RunUatTesterOpts,
  type TesterTarget,
} from './tester.js';
import type { AgentAdapter, HeadlessResult, RunHeadlessOpts } from '../../agent/adapter.js';

const now = () => '2026-08-08T10:00:00.000Z';

const TARGETS: readonly TesterTarget[] = [
  { repo: '/web', worktreePath: '/wt/web', baseRef: 'develop', service: { start: 'npm run dev' } },
];

const ASSIGNMENT = { agentName: 'UAT Agent', provider: 'claude' as const, model: 'claude-sonnet-5' };

function fakeAdapter(
  respond: (opts: RunHeadlessOpts) => Promise<HeadlessResult>,
): { adapter: AgentAdapter; calls: RunHeadlessOpts[] } {
  const calls: RunHeadlessOpts[] = [];
  return {
    calls,
    adapter: {
      requiredBinary: 'fake',
      capabilities: { lifecycleEvents: false, resume: false },
      buildInteractiveCommand: () => {
        throw new Error('not used by the tester');
      },
      runHeadless: async (opts) => {
        calls.push(opts);
        return respond(opts);
      },
    },
  };
}

const rawAdapter = (raw: string) => fakeAdapter(async () => ({ sessionId: '', verdict: null, raw }));

/**
 * The UAT Tester (Task 8): the ONE AI process in UAT, run only after the
 * required gates pass. Its observations are advisory evidence — they can never
 * pass, fail, transition, or spend a recovery round by themselves; only the
 * deterministic `uat.testerVerifier` boundary (the stage's job) is a
 * Tester-specific verdict source.
 */
describe('runUatTester', () => {
  let store: Store;
  let ticketId: number;

  beforeEach(() => {
    store = openStore(':memory:');
    ticketId = createTicketFlow(store, { key: 'T-1', title: 't' }).id;
    transition(store, ticketId, 'scope', { kind: 'passed' });
    transition(store, ticketId, 'impl', { kind: 'passed' });
  });
  afterEach(() => store.close());

  const opts = (over: Partial<RunUatTesterOpts> = {}): RunUatTesterOpts => ({
    ticketId,
    targets: TARGETS,
    assignment: ASSIGNMENT,
    adapter: rawAdapter('[]').adapter,
    ...over,
  });

  it('observes the target, records the observations and finishes the process run as observed', async () => {
    const { adapter, calls } = rawAdapter(
      JSON.stringify([
        { severity: 'high', title: 'login is broken', detail: '…', file: 'src/login.ts', line: 41 },
        { severity: 'info', title: 'nit', detail: '' },
      ]),
    );
    const res = await runUatTester(store, opts({ adapter }), { now });
    expect(res).toEqual({ kind: 'observed', findingIds: [1, 2] });
    const run = listProcessRuns(store, ticketId)[0]!;
    expect(run).toMatchObject({
      processId: 'tester',
      stageKey: 'uat',
      resultKind: 'observed',
      status: 'passed',
      // The identity snapshot is captured at launch and immutable.
      agentName: 'UAT Agent',
      provider: 'claude',
      model: 'claude-sonnet-5',
    });
    expect(run.endedAt).toBe(now());
    const findings = listUatFindings(store, ticketId);
    expect(findings).toHaveLength(2);
    expect(findings[0]).toMatchObject({
      processRunId: run.id,
      severity: 'high',
      repo: '/web',
      filePath: 'src/login.ts',
      line: 41,
    });
    expect(findings[1]).toMatchObject({ severity: 'info', repo: '/web' });
    // Token attribution: the call declares the uat-tester site and the opened
    // Tester process run, so spend lands on the process that produced it.
    expect(calls[0]!.tracking).toEqual({ callSite: 'uat-tester', ticketId, processRunId: run.id });
  });

  it('keeps blocking-severity observations — the Tester never filters by severity', async () => {
    const { adapter } = rawAdapter(
      JSON.stringify([
        { severity: 'critical', title: 'data loss', detail: '' },
        { severity: 'low', title: 'nit', detail: '' },
      ]),
    );
    const res = await runUatTester(store, opts({ adapter }), { now });
    expect(res.kind).toBe('observed');
    expect(listUatFindings(store, ticketId).map((f) => f.severity)).toEqual(['critical', 'low']);
  });

  it('malformed output is observed with no findings, not an error', async () => {
    const { adapter } = rawAdapter('sure, looks fine to me!');
    const res = await runUatTester(store, opts({ adapter }), { now });
    expect(res).toEqual({ kind: 'observed', findingIds: [] });
    expect(listProcessRuns(store, ticketId)[0]!.resultKind).toBe('observed');
  });

  it('an adapter crash is execution-failed, finished failed, and never transitions anything', async () => {
    const { adapter } = fakeAdapter(async () => {
      throw new Error('spawn ENOENT');
    });
    const res = await runUatTester(store, opts({ adapter }), { now });
    expect(res).toEqual({ kind: 'execution-failed', message: 'spawn ENOENT' });
    expect(listProcessRuns(store, ticketId)[0]).toMatchObject({
      resultKind: 'execution-failed',
      status: 'failed',
    });
    expect(listUatFindings(store, ticketId)).toEqual([]);
  });

  it('a Stop aborts the run as interrupted, never a verdict', async () => {
    const controller = new AbortController();
    controller.abort();
    const { adapter, calls } = rawAdapter('[]');
    const res = await runUatTester(store, opts({ adapter, signal: controller.signal }), { now });
    expect(res).toEqual({ kind: 'interrupted' });
    expect(listProcessRuns(store, ticketId)[0]).toMatchObject({
      resultKind: 'interrupted',
      status: 'interrupted',
    });
    expect(calls).toEqual([]);
  });

  it('attributes every observation to the TARGET repo, never one the model claimed', async () => {
    const { adapter } = rawAdapter(
      JSON.stringify([{ severity: 'medium', title: 'x', detail: '', file: '../outside.ts' }]),
    );
    const res = await runUatTester(store, opts({ adapter }), { now });
    expect(res.kind).toBe('observed');
    // The traversal attempt was rejected; the finding stays attributed to /web.
    expect(listUatFindings(store, ticketId)[0]).toMatchObject({ repo: '/web', filePath: null });
  });

  it('links each target to its own observations across targets', async () => {
    const { adapter } = fakeAdapter(async (headlessOpts) => ({
      sessionId: '',
      verdict: null,
      raw: JSON.stringify([{ severity: 'low', title: headlessOpts.cwd, detail: '' }]),
    }));
    const res = await runUatTester(
      store,
      opts({
        adapter,
        targets: [
          { repo: '/web', worktreePath: '/wt/web' },
          { repo: '/api', worktreePath: '/wt/api' },
        ],
      }),
      { now },
    );
    expect(res.kind).toBe('observed');
    expect(listUatFindings(store, ticketId).map((f) => f.repo).sort()).toEqual(['/api', '/web']);
  });

  it('supersedes a still-running Tester run of the same process as stale the moment a fresh one opens', async () => {
    // A run still `running` when a second one opens is exactly the
    // destroyed-run case a host restart produces: the driver single-flights,
    // so a second open run for the same process can only mean the first one's
    // host died. The Tester's own open marks it stale.
    const orphaned = openProcessRun(store, {
      ticketId,
      stageKey: 'uat',
      processId: 'tester',
      attempt: 0,
      startedAt: '2026-08-08T09:30:00.000Z',
    });
    const { adapter } = rawAdapter('[]');
    await runUatTester(store, opts({ adapter }), { now });
    const runs = listProcessRuns(store, ticketId);
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({ id: orphaned.id, status: 'stale' });
    expect(runs[1]).toMatchObject({ processId: 'tester', status: 'passed', resultKind: 'observed' });
  });
});

describe('buildTesterPrompt', () => {
  it('names the target repository, its base branch and its host-known service context', () => {
    const prompt = buildTesterPrompt(TARGETS[0]!);
    expect(prompt).toContain('/web');
    expect(prompt).toContain('develop');
    expect(prompt).toContain('npm run dev');
    expect(prompt).toContain('JSON array');
  });

  it('falls back to generic wording when no base ref or service is known', () => {
    const prompt = buildTesterPrompt({ repo: '/web', worktreePath: '/wt/web' });
    expect(prompt).not.toContain('undefined');
    expect(prompt).toContain('its base branch.');
  });
});
