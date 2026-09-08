import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
import * as reviewSnapshot from '../reviewSnapshot.js';
import type { AgentAdapter, HeadlessResult, RunHeadlessOpts } from '../../agent/adapter.js';
import type { GitRunner } from '../../integrations/git.js';
import { GATE_LANE_HEADLESS_TIMEOUT_MS } from '../../agent/headlessSpawn.js';

const now = () => '2026-08-08T10:00:00.000Z';

const TARGETS: readonly TesterTarget[] = [
  { repo: '/web', worktreePath: '/wt/web', baseRef: 'develop', service: { start: 'npm run dev' } },
];

const ASSIGNMENT = { agentName: 'UAT Agent', provider: 'claude' as const, model: 'claude-sonnet-5' };

/** A git runner that answers `rev-parse --abbrev-ref HEAD` with `branch`. */
function fakeGit(branch: string | null, exitCode = 0): GitRunner {
  return async (args) => ({
    exitCode: branch === null ? 1 : exitCode,
    stdout: exitCode === 0 && branch !== null ? `${branch}\n` : '',
    stderr: '',
  });
}

function scriptedGit(
  replies: Record<string, { stdout?: string; stderr?: string; exitCode?: number }>,
): { git: GitRunner; calls: string[][] } {
  const calls: string[][] = [];
  const git: GitRunner = async (args) => {
    calls.push(args);
    const key = args.join(' ');
    const r = replies[key] ?? replies[args[0]!] ?? {};
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', exitCode: r.exitCode ?? 0 };
  };
  return { git, calls };
}

/** A git runner that can never answer (cwd missing, git absent) — verification is skipped. */
const neverGit: GitRunner = async () => ({ exitCode: 1, stdout: '', stderr: '' });

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
    git: neverGit,
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
    expect(res).toEqual({ kind: 'observed', findingIds: [1, 2], blocking: 0 });
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

  // Task 3.2: the observations stay advisory BY DEFAULT. The one manifest knob
  // `uat.testerObservations.blockingSeverity` (threaded in as
  // `observationsBlockingSeverity`) is what makes them countable as blocking;
  // the STAGE turns a nonzero count into a verdict.
  it('reports blocking observations when the threshold is set', async () => {
    const { adapter } = rawAdapter(
      JSON.stringify([
        { severity: 'high', title: 'login is broken', detail: '' },
        { severity: 'low', title: 'nit', detail: '' },
      ]),
    );
    const res = await runUatTester(
      store,
      opts({ adapter, observationsBlockingSeverity: 'high' }),
      { now },
    );
    expect(res).toMatchObject({ kind: 'observed', blocking: 1, blockingSummary: '1 high' });
  });

  it('reports no blocking observations when the threshold is none', async () => {
    const { adapter } = rawAdapter(
      JSON.stringify([{ severity: 'critical', title: 'data loss', detail: '' }]),
    );
    const res = await runUatTester(store, opts({ adapter }), { now });
    expect(res).toMatchObject({ kind: 'observed', blocking: 0 });
    expect(res).not.toHaveProperty('blockingSummary');
  });

  it('never counts an observation the cap truncated away', async () => {
    const { adapter } = rawAdapter(
      JSON.stringify([
        { severity: 'critical', title: 'data loss', detail: '' },
        { severity: 'high', title: 'also bad', detail: '' },
      ]),
    );
    const res = await runUatTester(
      store,
      opts({ adapter, maxObservations: 1, observationsBlockingSeverity: 'high' }),
      { now },
    );
    // The `high` was cut by the cap; only the surviving `critical` counts.
    expect(res).toMatchObject({ kind: 'observed', blocking: 1, blockingSummary: '1 critical' });
  });

  it('closes the run as unreadable-output when the core answered prose', async () => {
    const { adapter } = rawAdapter('I ran the tests and everything looked fine.');
    const res = await runUatTester(store, opts({ adapter }), { now });
    expect(res).toMatchObject({
      kind: 'unreadable-output',
      preview: expect.stringContaining('I ran the tests and everything looked fine.'),
    });
    const run = listProcessRuns(store, ticketId).at(-1)!;
    expect(run.resultKind).toBe('unreadable-output');
    expect(run.status).toBe('failed');
  });

  // 869ekt: a core that exits clean having said NOTHING (opencode ending its
  // turn on a tool call) used to reach here as an adapter crash. It is an empty
  // answer: the target is re-asked ONCE with a nudge before it is written off.
  it('re-asks a target once when the core answered nothing at all', async () => {
    let call = 0;
    const { adapter, calls } = fakeAdapter(async () => {
      call += 1;
      return {
        sessionId: '',
        verdict: null,
        raw: call === 1 ? '' : '[{"severity":"high","title":"button does nothing"}]',
      };
    });
    const res = await runUatTester(store, opts({ adapter }), { now });
    expect(res).toMatchObject({ kind: 'observed' });
    expect(calls).toHaveLength(2);
    // The nudge is appended to the SAME prompt — the target context and the
    // strict output rules must not be dropped on the retry.
    expect(calls[1]!.prompt.startsWith(calls[0]!.prompt)).toBe(true);
    expect(calls[1]!.prompt).not.toBe(calls[0]!.prompt);
    expect(listUatFindings(store, ticketId)).toHaveLength(1);
  });

  it('gives up after the silence re-ask AND the reformat re-ask and closes as unreadable-output', async () => {
    const { adapter, calls } = rawAdapter('');
    const res = await runUatTester(store, opts({ adapter }), { now });
    expect(res).toMatchObject({ kind: 'unreadable-output' });
    // 1: initial (empty) → silence nudge. 2: silence re-ask (still empty,
    // which also parses unreadable) → reformat nudge. 3: reformat re-ask.
    expect(calls).toHaveLength(3);
    const run = listProcessRuns(store, ticketId).at(-1)!;
    expect(run.resultKind).toBe('unreadable-output');
  });

  // UAT-19 amendment: the reformat nudge recovers a genuine finding a core
  // reported in prose instead of the required JSON shape.
  it('recovers a finding via the reformat nudge when the first answer was prose', async () => {
    let call = 0;
    const { adapter, calls } = fakeAdapter(async () => {
      call += 1;
      return {
        sessionId: '',
        verdict: null,
        raw:
          call === 1
            ? 'Found a dangling-reference bug: reported as medium.'
            : JSON.stringify([{ severity: 'medium', title: 'dangling reference', detail: '' }]),
      };
    });
    const res = await runUatTester(store, opts({ adapter }), { now });
    expect(res).toMatchObject({ kind: 'observed' });
    expect(calls).toHaveLength(2);
    // The reformat nudge quotes the prose back, bounded, inside the same prompt.
    expect(calls[1]!.prompt.startsWith(calls[0]!.prompt)).toBe(true);
    expect(calls[1]!.prompt).toContain('Found a dangling-reference bug');
    expect(listUatFindings(store, ticketId)).toHaveLength(1);
    expect(listUatFindings(store, ticketId)[0]!.title).toBe('dangling reference');
  });

  it('parks (unreadable-output) only after the reformat nudge also fails, and fires it at most once per target', async () => {
    const { adapter, calls } = rawAdapter('still prose, no matter how you ask');
    const res = await runUatTester(store, opts({ adapter }), { now });
    expect(res).toMatchObject({ kind: 'unreadable-output' });
    expect(calls).toHaveLength(2);
  });

  it('counts the reformat nudge separately from silenceNudges in v57 telemetry', async () => {
    const { adapter } = rawAdapter('prose, not json, twice');
    await runUatTester(store, opts({ adapter }), { now });
    const run = listProcessRuns(store, ticketId).at(-1)!;
    expect(run.promptTelemetry).toMatchObject({ reformatNudges: 1, silenceNudges: 0 });
  });

  it('bounds the unreadable answer before handing it on, and never logs the full agent output to debug', async () => {
    const longAnswer = 'x'.repeat(20_000);
    const { adapter } = rawAdapter(longAnswer);
    const debugLines: string[] = [];
    const res = await runUatTester(store, opts({ adapter, debug: (m) => debugLines.push(m) }), { now });
    expect(res.kind).toBe('unreadable-output');
    if (res.kind === 'unreadable-output') {
      expect(res.preview.length).toBeLessThan(longAnswer.length);
    }
    expect(debugLines.some((l) => l.includes(longAnswer))).toBe(false);
  });

  // Superseded by UAT-19's reformat nudge (see "recovers a finding via the
  // reformat nudge..." and "parks (unreadable-output) only after the reformat
  // nudge also fails" below): unreadable prose now DOES get one re-ask, a
  // reformat rather than a repeat of the same question.
  it('re-asks a target that answered unreadable prose exactly once, as a reformat', async () => {
    const { adapter, calls } = rawAdapter('I ran the tests and everything looked fine.');
    await runUatTester(store, opts({ adapter }), { now });
    expect(calls).toHaveLength(2);
  });

  it('still closes as observed when every target answered an empty array', async () => {
    const { adapter } = rawAdapter('[]');
    const res = await runUatTester(store, opts({ adapter }), { now });
    expect(res).toEqual({ kind: 'observed', findingIds: [], blocking: 0 });
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

  // 869ej1nfb: "UAT tester xterm console shows no diffs if they're there". A
  // worktree on the wrong branch (or a stale local branch ref at the base)
  // reads as "no changes" while the ticket's real work is elsewhere. The host
  // verifies the checkout BEFORE the agent runs: a mismatch records a
  // DETERMINISTIC critical observation and skips the token spend.
  it('skips a target whose checkout is not on the ticket branch, recording a deterministic critical observation', async () => {
    const { adapter, calls } = rawAdapter(
      JSON.stringify([{ severity: 'high', title: 'login is broken', detail: '' }]),
    );
    const res = await runUatTester(
      store,
      opts({
        adapter,
        git: fakeGit('develop'),
        targets: [{ repo: '/web', worktreePath: '/wt/web', branch: 'karst/x' }],
      }),
      { now },
    );
    expect(res).toEqual({ kind: 'observed', findingIds: [1], blocking: 0 });
    // No token was spent on a target the agent could not have tested.
    expect(calls).toEqual([]);
    const run = listProcessRuns(store, ticketId)[0]!;
    expect(run).toMatchObject({ processId: 'tester', resultKind: 'observed' });
    const findings = listUatFindings(store, ticketId);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      processRunId: run.id,
      severity: 'critical',
      repo: '/web',
      filePath: null,
      line: null,
    });
    expect(findings[0]!.title).toContain('on "develop"');
    expect(findings[0]!.title).toContain('karst/x');
  });

  it('runs the target normally when the checkout IS on the ticket branch', async () => {
    const { adapter, calls } = rawAdapter('[]');
    const res = await runUatTester(
      store,
      opts({
        adapter,
        git: fakeGit('karst/x'),
        targets: [{ repo: '/web', worktreePath: '/wt/web', branch: 'karst/x' }],
      }),
      { now },
    );
    expect(res).toEqual({ kind: 'observed', findingIds: [], blocking: 0 });
    expect(calls).toHaveLength(1);
    expect(listUatFindings(store, ticketId)).toEqual([]);
  });

  // The host verified the checkout BEFORE the call and git said the worktree
  // IS on the ticket branch. An agent that then claims "wrong checkout" is
  // reporting its core's own cwd mis-resolution (opencode resolves a linked
  // worktree back to the parent checkout), not a fact about this ticket — and
  // at a blocking severity it fails the stage over a diff nobody read. Review's
  // lane already drops the claim it can disprove; UAT now does the same.
  it('drops an agent "wrong checkout" claim the host has disproven', async () => {
    const { adapter } = rawAdapter(
      JSON.stringify([
        { severity: 'critical', title: 'wrong checkout', detail: 'expected karst/x, got develop' },
        { severity: 'high', title: 'login is broken', detail: '…' },
      ]),
    );
    const warnings: string[] = [];
    const res = await runUatTester(
      store,
      opts({
        adapter,
        git: fakeGit('karst/x'),
        targets: [{ repo: '/web', worktreePath: '/wt/web', branch: 'karst/x' }],
        warn: (m: string) => warnings.push(m),
      }),
      { now },
    );
    expect(res.kind).toBe('observed');
    const titles = listUatFindings(store, ticketId).map((f) => f.title);
    expect(titles).toEqual(['login is broken']);
    // Never silent: a dropped critical the user cannot see is indistinguishable
    // from an observation karst lost.
    expect(warnings.some((w) => w.includes('wrong checkout'))).toBe(true);
  });

  it('keeps a "wrong checkout" claim when git could not answer', async () => {
    const { adapter } = rawAdapter(
      JSON.stringify([{ severity: 'critical', title: 'wrong checkout', detail: '…' }]),
    );
    await runUatTester(
      store,
      opts({
        adapter,
        // No branch known → nothing verified → nothing may be dropped.
        targets: [{ repo: '/web', worktreePath: '/wt/web' }],
      }),
      { now },
    );
    expect(listUatFindings(store, ticketId).map((f) => f.title)).toEqual(['wrong checkout']);
  });

  it('does not verify a target with no known branch — the call runs as before', async () => {
    const runHeadless = vi.fn(async () => ({ sessionId: '', verdict: null, raw: '[]' }));
    await runUatTester(
      store,
      opts({ adapter: { ...rawAdapter('[]').adapter, runHeadless }, targets: TARGETS }),
      { now },
    );
    expect(runHeadless).toHaveBeenCalledTimes(1);
  });

  it('proceeds without verification when git cannot answer — an unreadable checkout is not a mismatch', async () => {
    const { adapter, calls } = rawAdapter('[]');
    const res = await runUatTester(
      store,
      opts({
        adapter,
        git: neverGit,
        targets: [{ repo: '/web', worktreePath: '/wt/web', branch: 'karst/x' }],
      }),
      { now },
    );
    expect(res).toEqual({ kind: 'observed', findingIds: [], blocking: 0 });
    expect(calls).toHaveLength(1);
    expect(listUatFindings(store, ticketId)).toEqual([]);
  });

  it('treats a detached HEAD as a wrong checkout when the ticket branch is known', async () => {
    const { adapter, calls } = rawAdapter('[]');
    const res = await runUatTester(
      store,
      opts({
        adapter,
        git: fakeGit('HEAD'),
        targets: [{ repo: '/web', worktreePath: '/wt/web', branch: 'karst/x' }],
      }),
      { now },
    );
    expect(res).toEqual({ kind: 'observed', findingIds: [1], blocking: 0 });
    expect(calls).toEqual([]);
    expect(listUatFindings(store, ticketId)[0]).toMatchObject({ severity: 'critical' });
  });

  it('names a wrong checkout in debug lines and per-target progress', async () => {
    const lines: string[] = [];
    const events: { repo: string; status: string; detail?: string }[] = [];
    await runUatTester(
      store,
      opts({
        adapter: rawAdapter('[]').adapter,
        git: fakeGit('develop'),
        targets: [{ repo: '/web', worktreePath: '/wt/web', branch: 'karst/x' }],
        debug: (m) => lines.push(m),
        onTargetProgress: (event) => events.push(event),
      }),
      { now },
    );
    expect(lines.some((l) => l.includes('WRONG CHECKOUT') && l.includes('develop'))).toBe(true);
    expect(events).toEqual([{ repo: '/web', status: 'completed', detail: 'wrong checkout — skipped' }]);
  });

  it('the prompt carries the snapshot range when a snapshot succeeds', async () => {
    const create = vi.spyOn(reviewSnapshot, 'createReviewSnapshot').mockResolvedValue(
      'refs/karst/snapshot/1/abc123abc123abcd',
    );
    const cleanup = vi.spyOn(reviewSnapshot, 'deleteReviewSnapshot').mockResolvedValue();
    const { adapter, calls: headlessCalls } = rawAdapter('[]');
    await runUatTester(
      store,
      opts({
        adapter,
        git: fakeGit('karst/x'),
        targets: [{ repo: '/web', worktreePath: '/wt/web', branch: 'karst/x', baseRef: 'develop' }],
      }),
      { now },
    );
    expect(headlessCalls[0]!.prompt).toContain('refs/karst/snapshot/');
    expect(headlessCalls[0]!.prompt).not.toContain('committed changes only');
    expect(create).toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalled();
    create.mockRestore();
    cleanup.mockRestore();
  });

  it('a snapshot failure falls back to the branch range and still runs the target', async () => {
    const create = vi.spyOn(reviewSnapshot, 'createReviewSnapshot').mockResolvedValue(null);
    const cleanup = vi.spyOn(reviewSnapshot, 'deleteReviewSnapshot').mockResolvedValue();
    const { adapter, calls: headlessCalls } = rawAdapter('[]');
    await runUatTester(
      store,
      opts({
        adapter,
        git: fakeGit('karst/x'),
        targets: [{ repo: '/web', worktreePath: '/wt/web', branch: 'karst/x', baseRef: 'develop' }],
      }),
      { now },
    );
    expect(headlessCalls).toHaveLength(1);
    expect(headlessCalls[0]!.prompt).toContain('git diff origin/develop...origin/karst/x');
    expect(create).toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
    create.mockRestore();
    cleanup.mockRestore();
  });

  it('the snapshot ref is deleted after the run', async () => {
    const create = vi.spyOn(reviewSnapshot, 'createReviewSnapshot').mockResolvedValue(
      'refs/karst/snapshot/1/abc123abc123abcd',
    );
    const cleanup = vi.spyOn(reviewSnapshot, 'deleteReviewSnapshot').mockResolvedValue();
    const { adapter } = rawAdapter('[]');
    await runUatTester(
      store,
      opts({
        adapter,
        git: fakeGit('karst/x'),
        targets: [{ repo: '/web', worktreePath: '/wt/web', branch: 'karst/x', baseRef: 'develop' }],
      }),
      { now },
    );
    expect(create).toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalled();
    create.mockRestore();
    cleanup.mockRestore();
  });

  it('the ref is deleted even when the adapter throws', async () => {
    const create = vi.spyOn(reviewSnapshot, 'createReviewSnapshot').mockResolvedValue(
      'refs/karst/snapshot/1/abc123abc123abcd',
    );
    const cleanup = vi.spyOn(reviewSnapshot, 'deleteReviewSnapshot').mockResolvedValue();
    const { adapter } = fakeAdapter(async () => {
      throw new Error('spawn ENOENT');
    });
    const res = await runUatTester(
      store,
      opts({
        adapter,
        git: fakeGit('karst/x'),
        targets: [{ repo: '/web', worktreePath: '/wt/web', branch: 'karst/x', baseRef: 'develop' }],
      }),
      { now },
    );
    expect(res).toEqual({ kind: 'execution-failed', message: 'spawn ENOENT' });
    expect(create).toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalled();
    create.mockRestore();
    cleanup.mockRestore();
  });

  it('opts.git absent means no snapshot calls and the prompt stays branch-based', async () => {
    const { adapter, calls: headlessCalls } = rawAdapter('[]');
    await runUatTester(
      store,
      opts({
        adapter,
        git: undefined,
        targets: [{ repo: '/web', worktreePath: '/wt/web', branch: 'karst/x', baseRef: 'develop' }],
      }),
      { now },
    );
    expect(headlessCalls[0]!.prompt).toContain('git diff origin/develop...origin/karst/x');
    expect(headlessCalls[0]!.prompt).not.toContain('refs/karst/snapshot/');
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
    expect(res).toEqual({ kind: 'observed', findingIds: [1], blocking: 0 });
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

  it('forwards onOutput verbatim into each headless call', async () => {
    const { adapter, calls } = fakeAdapter(async () => ({ sessionId: '', verdict: null, raw: '[]' }));
    const chunks: { stream: 'stdout' | 'stderr'; text: string }[] = [];
    await runUatTester(
      store,
      opts({
        adapter,
        onOutput: (chunk) => chunks.push(chunk),
      }),
      { now },
    );
    expect(calls[0]!.onOutput).toBeDefined();
    calls[0]!.onOutput?.({ stream: 'stdout', text: 'hello' });
    expect(chunks).toEqual([{ stream: 'stdout', text: 'hello' }]);
  });

  it('emits per-target active/completed progress with a detail naming what came back', async () => {
    const { adapter } = fakeAdapter(async (opts) => {
      const one = opts.cwd === '/wt/web';
      return {
        sessionId: '',
        verdict: null,
        raw: JSON.stringify(
          one ? [{ severity: 'low', title: 'nit', detail: '' }] : [],
        ),
      };
    });
    const events: { repo: string; status: string; detail?: string }[] = [];
    await runUatTester(
      store,
      opts({
        adapter,
        targets: [
          { repo: '/web', worktreePath: '/wt/web' },
          { repo: '/api', worktreePath: '/wt/api' },
        ],
        onTargetProgress: (event) => events.push(event),
      }),
      { now },
    );
    expect(events).toEqual([
      { repo: '/web', status: 'active' },
      { repo: '/web', status: 'completed', detail: '1 observation' },
      { repo: '/api', status: 'active' },
      { repo: '/api', status: 'completed', detail: '0 observations' },
    ]);
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

  it('threads the assignment instructions into the prompt it sends', async () => {
    const { adapter, calls } = rawAdapter('[]');
    const res = await runUatTester(
      store,
      opts({
        adapter,
        assignment: { ...ASSIGNMENT, instructions: 'Focus on API endpoint behavior.' },
      }),
      { now },
    );
    expect(res.kind).toBe('observed');
    expect(calls[0]!.prompt).toContain('Focus on API endpoint behavior.');
    expect(calls[0]!.prompt).toContain('Output rules (strict):');
    // The instructed run's output still parses ([] → zero findings recorded).
    expect(listUatFindings(store, ticketId)).toHaveLength(0);
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

  // fu1: "review agent xterm log shows no changes, but diffs are present". The
  // branch is known to the host (`worktrees.branch`) and the scope block uses
  // `origin/<branch>` so a stale local ref never produces an empty diff.
  it('names the ticket branch in the scope block when one is known', () => {
    const prompt = buildTesterPrompt({ ...TARGETS[0]!, branch: 'karst/feat/x' });
    expect(prompt).toContain('git diff origin/develop...origin/karst/feat/x');
    expect(prompt).not.toContain('...HEAD');
    expect(prompt).toContain('This ticket\'s branch is `karst/feat/x`');
  });

  it('replaces the role/strategy lines with user instructions, keeping the target context and output rules', () => {
    const prompt = buildTesterPrompt(
      TARGETS[0]!,
      'Focus on API endpoint behavior.\nTest edge cases around authentication and rate limiting.',
    );
    expect(prompt).toContain(
      'Focus on API endpoint behavior.\nTest edge cases around authentication and rate limiting.',
    );
    // The facts the agent needs survive — repo, base branch, service context.
    expect(prompt).toContain('Repository: /web');
    expect(prompt).toContain('develop');
    expect(prompt).toContain('npm run dev');
    // The default role/strategy lines are replaced...
    expect(prompt).not.toContain('Act as the UAT tester');
    expect(prompt).not.toContain('Try to BREAK');
    // ...but the structured-output contract is non-negotiable.
    expect(prompt).toContain('Output rules (strict):');
    expect(prompt).toContain('JSON array');
    expect(prompt).toContain('OBSERVATIONS, not verdicts');
  });

  it('a profile override (instructions) cannot displace the un-exercisable-criterion severity rule', () => {
    const prompt = buildTesterPrompt(
      TARGETS[0]!,
      'Focus on API endpoint behavior.',
    );
    // The severity floor is a product invariant in the never-replaced output-rules tail.
    expect(prompt).toContain('A criterion you could NOT exercise is severity `info`, never `high`');
    expect(prompt).toContain('`high` is reserved for a criterion you exercised and observed to be unmet');
  });

  it('carries the scope block so the Tester does not survey the repo first', () => {
    const prompt = buildTesterPrompt(TARGETS[0]!, undefined, ['test:unit (web)']);
    expect(prompt).toContain('Do NOT run repository-wide reconnaissance');
    expect(prompt).toContain('git worktree list');
    expect(prompt).toContain('test:unit (web)');
    expect(prompt).toContain('Do NOT re-run them');
  });

  it('keeps the scope block even when user instructions replace the strategy', () => {
    const prompt = buildTesterPrompt(TARGETS[0]!, 'Focus on API endpoint behavior.');
    expect(prompt).toContain('Do NOT run repository-wide reconnaissance');
  });

  it('uses the snapshot range when a snapshot ref is present', () => {
    const prompt = buildTesterPrompt(
      TARGETS[0]!,
      undefined,
      undefined,
      'refs/karst/snapshot/7/abc123abc123abcd',
    );
    expect(prompt).toContain('refs/karst/snapshot/7/abc123abc123abcd');
    expect(prompt).not.toContain('committed changes only');
  });

  it('treats blank or whitespace instructions as absent', () => {
    const blank = buildTesterPrompt(TARGETS[0]!, '   ');
    expect(blank).toContain('Act as the UAT tester');
    expect(blank).toContain('Try to BREAK');
  });

  it('carries the ticket criteria as an authoritative block between the strategy and the scope block', () => {
    const prompt = buildTesterPrompt(TARGETS[0]!, undefined, undefined, undefined, {
      criteria: 'The button must open the modal.',
    });
    expect(prompt).toContain('Done-when criteria for this ticket (authoritative');
    expect(prompt).toContain('The button must open the modal.');
    const criteriaIdx = prompt.indexOf('Done-when criteria');
    const scopeIdx = prompt.indexOf('Scope rules');
    expect(criteriaIdx).toBeGreaterThan(-1);
    expect(scopeIdx).toBeGreaterThan(criteriaIdx);
  });

  it('omits the criteria block when absent or blank', () => {
    const absent = buildTesterPrompt(TARGETS[0]!);
    expect(absent).not.toContain('Done-when criteria');
    const blank = buildTesterPrompt(TARGETS[0]!, undefined, undefined, undefined, {
      criteria: '   ',
    });
    expect(blank).not.toContain('Done-when criteria');
  });

  it('a profile override (instructions) cannot displace the criteria block', () => {
    const prompt = buildTesterPrompt(TARGETS[0]!, 'Focus on API endpoint behavior.', undefined, undefined, {
      criteria: 'The button must open the modal.',
    });
    expect(prompt).toContain('The button must open the modal.');
    expect(prompt).toContain('Focus on API endpoint behavior.');
  });

  // PROMPT-21: truncation of the criteria block must be stated, never silent —
  // the agent must know criteria are missing and be told how to recover them.
  it('yields a stated truncation pointer when the criteria exceed the budget', () => {
    const overCap = 'x'.repeat(9_000);
    const prompt = buildTesterPrompt(TARGETS[0]!, undefined, undefined, undefined, {
      criteria: overCap,
      ticketKey: 'PROMPT-21',
      contextCommand: 'node "cli.js" context --db "db"',
    });
    expect(prompt).toContain('truncated -- run `karst context PROMPT-21` for the full state.');
    // The raw criteria must NOT appear in full — only the budget-sized prefix.
    expect(prompt).not.toContain(overCap);
  });

  it('leaves an under-cap criteria block unchanged', () => {
    const underCap = 'The button must open the modal.';
    const prompt = buildTesterPrompt(TARGETS[0]!, undefined, undefined, undefined, {
      criteria: underCap,
      ticketKey: 'PROMPT-21',
      contextCommand: 'node "cli.js" context --db "db"',
    });
    expect(prompt).toContain(underCap);
    expect(prompt).not.toContain('truncated --');
  });

  it('never points at a karst context command it cannot name when the ticket key is missing', () => {
    const overCap = 'c'.repeat(9_000);
    const prompt = buildTesterPrompt(TARGETS[0]!, undefined, undefined, undefined, {
      criteria: overCap,
    });
    expect(prompt).toContain('truncated');
    expect(prompt).not.toContain('karst context ');
  });

  it('names one command for pulling the rest of the ticket context, and only that command is permitted past the recon ban', () => {
    const prompt = buildTesterPrompt(TARGETS[0]!, undefined, undefined, undefined, {
      ticketKey: 'PROMPT-17',
      contextCommand: 'node "cli.js" context --db "db"',
    });
    expect(prompt).toContain(
      'Run exactly: node "cli.js" context --db "db" PROMPT-17 --md',
    );
    expect(prompt).toContain('Nothing else about the orchestrator is in scope.');
    expect(prompt).toContain('The one exception is the command named above');
  });

  it('omits the pointer line and keeps the ban unqualified when no context command is given', () => {
    const prompt = buildTesterPrompt(TARGETS[0]!);
    expect(prompt).not.toContain('Run exactly:');
    expect(prompt).toContain(
      'No querying the orchestration tool that launched you — its CLI or its state database.',
    );
  });

  it('keeps the ban unqualified when contextCommand is set but ticketKey is absent', () => {
    // The scope block must not grant an exception for "the command named above"
    // when no command was named — the dangling-reference defect (fu1).
    const prompt = buildTesterPrompt(TARGETS[0]!, undefined, undefined, undefined, {
      contextCommand: 'node "cli.js" context --db "db"',
    });
    expect(prompt).not.toContain('Run exactly:');
    expect(prompt).toContain(
      'No querying the orchestration tool that launched you — its CLI or its state database.',
    );
    expect(prompt).not.toContain('The one exception is the command named above');
  });
});

describe('runUatTester — silence-nudge telemetry (v57)', () => {
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
    git: neverGit,
    ...over,
  });

  it('records a nudge fire count when a silent target is re-asked', async () => {
    let n = 0;
    const { adapter } = fakeAdapter(async () => {
      n += 1;
      // Empty first (triggers the ONE re-ask), an answer second.
      return { sessionId: '', verdict: null, raw: n === 1 ? '' : '[]' };
    });
    await runUatTester(store, opts({ adapter }), { now });
    const run = listProcessRuns(store, ticketId)[0]!;
    expect(run.promptTelemetry).toMatchObject({ silenceNudges: 1 });
  });

  it('records zero when no target was ever silent', async () => {
    await runUatTester(store, opts(), { now });
    const run = listProcessRuns(store, ticketId)[0]!;
    expect(run.promptTelemetry).toMatchObject({ silenceNudges: 0 });
  });
});
