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
import { GATE_LANE_HEADLESS_TIMEOUT_MS } from '../../agent/headlessSpawn.js';

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
    expect(calls[0]!.model).toBe('claude-sonnet-5');
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

  // The tester is asked to RUN the repo's tests and exercise the acceptance
  // criteria — a chat-tuned model needs many minutes of tool calls for that,
  // so the lane's own deadline is the generous gate-lane bound, never the
  // 15-minute quick-call backstop that killed UAT testing mid-run.
  it('defaults the headless deadline to the gate-lane bound, so a tester exercising the repo is not cut off', async () => {
    const { adapter, calls } = rawAdapter('[]');
    await runUatTester(store, opts({ adapter }), { now });
    expect(calls[0]!.timeoutMs).toBe(GATE_LANE_HEADLESS_TIMEOUT_MS);
  });

  it('honors an explicit headless deadline from the caller', async () => {
    const { adapter, calls } = rawAdapter('[]');
    await runUatTester(store, opts({ adapter, timeoutMs: 42_000 }), { now });
    expect(calls[0]!.timeoutMs).toBe(42_000);
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

  it('treats an adapter rejection caused by Stop as interrupted, never execution-failed', async () => {
    const controller = new AbortController();
    const { adapter } = fakeAdapter(
      ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('aborted by Stop')));
          controller.abort();
        }),
    );

    const res = await runUatTester(store, opts({ adapter, signal: controller.signal }), { now });

    expect(res).toEqual({ kind: 'interrupted' });
    expect(listProcessRuns(store, ticketId)[0]).toMatchObject({
      resultKind: 'interrupted',
      status: 'interrupted',
    });
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

  // Finding 13: the cap used to apply PER target, so a 10-repository run could
  // persist ten times the documented execution cap. It is ONE execution-wide
  // budget: two targets each returning more than half the cap must persist
  // EXACTLY `maxObservations`, in target order, with the second target
  // truncated at the shared budget.
  it('applies ONE observation cap across the whole execution, truncating later targets at the shared budget', async () => {
    const many = (n: number): string =>
      JSON.stringify(
        Array.from({ length: n }, (_, i) => ({ severity: 'info' as const, title: `o${i}`, detail: '' })),
      );
    const { adapter, calls } = rawAdapter(many(40));
    const res = await runUatTester(
      store,
      opts({
        adapter,
        maxObservations: 60,
        targets: [
          { repo: '/web', worktreePath: '/wt/web' },
          { repo: '/api', worktreePath: '/wt/api' },
        ],
        warn: () => {},
      }),
      { now },
    );
    expect(res.kind).toBe('observed');
    const rows = listUatFindings(store, ticketId);
    expect(rows).toHaveLength(60);
    // Target order preserved: the first target's 40 survive whole, the second
    // is cut to the 20 the execution had left.
    expect(rows.slice(0, 40).every((f) => f.repo === '/web')).toBe(true);
    expect(rows.slice(40).every((f) => f.repo === '/api')).toBe(true);
    expect(calls).toHaveLength(2);
  });

  // Finding 13 follow-up: the cap used to BREAK out of the target loop the
  // moment the budget hit zero, so repo A's 100 lows meant repo B was never
  // even asked — a later `critical` was silently discarded. The cap is
  // execution-wide WITHOUT skipping repositories: every target is asked, the
  // collection is ranked by severity, and the cut happens exactly once.
  it('asks EVERY target before capping: a later critical survives a full cap of earlier lows', async () => {
    const lows = (n: number): string =>
      JSON.stringify(
        Array.from({ length: n }, (_, i) => ({ severity: 'low' as const, title: `low${i}`, detail: '' })),
      );
    const { adapter, calls } = fakeAdapter(async (headlessOpts) => ({
      sessionId: '',
      verdict: null,
      raw:
        headlessOpts.cwd === '/wt/web'
          ? lows(100)
          : JSON.stringify([{ severity: 'critical' as const, title: 'data loss', detail: '' }]),
    }));
    const res = await runUatTester(
      store,
      opts({
        adapter,
        maxObservations: 100,
        targets: [
          { repo: '/web', worktreePath: '/wt/web' },
          { repo: '/api', worktreePath: '/wt/api' },
        ],
        warn: () => {},
      }),
      { now },
    );
    expect(res.kind).toBe('observed');
    // The cap never skipped repo B: both adapters ran.
    expect(calls).toHaveLength(2);
    const rows = listUatFindings(store, ticketId);
    expect(rows).toHaveLength(100);
    // The severity rank cut: the later critical outranks the 100 earlier lows
    // and survives the single slice; exactly 99 of the lows remain.
    expect(rows[0]).toMatchObject({ severity: 'critical', repo: '/api' });
    const lowsKept = rows.filter((f) => f.severity === 'low');
    expect(lowsKept).toHaveLength(99);
    // Stable within the rank: the kept lows hold their original report order.
    expect(lowsKept.map((f) => f.title)).toEqual(Array.from({ length: 99 }, (_, i) => `low${i}`));
  });

  it('keeps original order among equal severities across targets when the cap cuts', async () => {
    // repo A reports [high h0, low l0]; repo B reports [high h1]. Cap 2 →
    // both highs survive, and the h0/h1 tie resolves to original target order
    // rather than anything the response order could influence.
    const { adapter, calls } = fakeAdapter(async (headlessOpts) => ({
      sessionId: '',
      verdict: null,
      raw:
        headlessOpts.cwd === '/wt/web'
          ? JSON.stringify([
              { severity: 'high' as const, title: 'h0', detail: '' },
              { severity: 'low' as const, title: 'l0', detail: '' },
            ])
          : JSON.stringify([{ severity: 'high' as const, title: 'h1', detail: '' }]),
    }));
    const res = await runUatTester(
      store,
      opts({
        adapter,
        maxObservations: 2,
        targets: [
          { repo: '/web', worktreePath: '/wt/web' },
          { repo: '/api', worktreePath: '/wt/api' },
        ],
        warn: () => {},
      }),
      { now },
    );
    expect(res.kind).toBe('observed');
    expect(calls).toHaveLength(2);
    expect(listUatFindings(store, ticketId).map((f) => f.title)).toEqual(['h0', 'h1']);
  });

  it('emits debug lines at entry, per target, and at exit — never the prompt text', async () => {
    const lines: string[] = [];
    const { adapter } = rawAdapter(
      JSON.stringify([{ severity: 'high', title: 'login is broken', detail: '' }]),
    );
    const res = await runUatTester(
      store,
      opts({ adapter, debug: (m) => lines.push(m) }),
      { now },
    );
    expect(res).toEqual({ kind: 'observed', findingIds: [1] });
    // Entry: what is being attempted — targets and the execution cap.
    expect(lines.some((l) => l.includes('uat tester ticket') && l.includes('1 target(s)'))).toBe(
      true,
    );
    // Per-target: which repository was asked and what it came back with.
    expect(lines.some((l) => l.includes('asking target /web'))).toBe(true);
    expect(lines.some((l) => l.includes('/web returned 1 observation(s)'))).toBe(true);
    // Exit: the outcome.
    expect(lines.some((l) => l.includes('recorded 1 finding(s)'))).toBe(true);
    // Debug lines never carry the prompt (ticket prose) — only lengths/counts.
    for (const line of lines) {
      expect(line).not.toContain('Act as the UAT tester');
    }
  });

  it('debug lines name a cap truncation and an execution failure when they happen', async () => {
    // Each response is parse-capped at `maxObservations` (5), so two targets
    // returning 20 each collect 10 — which is where the execution-wide cut
    // actually bites: 10 → 5.
    const many = JSON.stringify(
      Array.from({ length: 20 }, (_, i) => ({ severity: 'info' as const, title: `o${i}`, detail: '' })),
    );
    const lines: string[] = [];
    await runUatTester(
      store,
      opts({
        adapter: rawAdapter(many).adapter,
        maxObservations: 5,
        targets: [
          { repo: '/web', worktreePath: '/wt/web' },
          { repo: '/api', worktreePath: '/wt/api' },
        ],
        debug: (m) => lines.push(m),
      }),
      { now },
    );
    expect(lines.some((l) => l.includes('capped 10 → 5 observation(s)'))).toBe(true);

    const failed: string[] = [];
    await runUatTester(
      store,
      opts({
        adapter: fakeAdapter(async () => {
          throw new Error('spawn ENOENT');
        }).adapter,
        debug: (m) => failed.push(m),
      }),
      { now },
    );
    expect(failed.some((l) => l.includes('execution-failed') && l.includes('spawn ENOENT'))).toBe(
      true,
    );
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
