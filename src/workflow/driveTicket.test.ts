import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../store/db.js';
import { getTicket } from '../store/tickets.js';
import { stageBlock } from '../store/stageBlocks.js';
import { listProcessRuns } from '../store/processRuns.js';
import { listUatFindings } from '../store/uatFindings.js';
import { transition } from './machine.js';
import { createTicketFlow } from './stages/create.js';
import { ticketsToSweep } from './driverController.js';
import { manifest, repo, uat, review } from '../manifest/fixtures.js';
import type { GitRunner } from '../integrations/git.js';
import type { StageRunResult } from '../model/types.js';
import { runUat } from './stages/uat.js';
import { driveTicket, fixResumeDecision, type DriveTicketDeps } from './driveTicket.js';
import type { UatDeps } from './stages/uat.js';
import type { ReviewDeps } from './stages/review.js';
import { runProcess } from './gates/run.js';
import type { AgentAdapter } from '../agent/adapter.js';
import { openRecoveryRound, listRecoveryRounds } from '../store/recoveryRounds.js';

describe('fixResumeDecision', () => {
  const stages = (uatAttempt: number, reviewAttempt: number) => [
    { stageKey: 'uat', status: 'failed', endedAt: '2026-07-30T10:00:00.000Z', attempt: uatAttempt },
    { stageKey: 'review', status: 'passed', endedAt: '2026-07-30T09:00:00.000Z', attempt: reviewAttempt },
  ];

  it('resumes against the gate that failed, under that gate budget', () => {
    expect(fixResumeDecision(stages(1, 2), undefined)).toEqual({
      kind: 'resume', gate: 'uat', attempts: 1,
    });
  });

  it('honours uat.maxFixAttempts for the uat budget', () => {
    expect(
      fixResumeDecision(stages(1, 0), manifest({}, { uat: uat({ maxFixAttempts: 1 }) })),
    ).toEqual({ kind: 'exhausted', gate: 'uat', attempts: 1, cap: 1 });
  });

  it('leaves review on the default cap when uat.maxFixAttempts is lowered', () => {
    // The uat knob must not narrow review's budget: each gate's budget is its
    // own manifest key, so lowering uat's must not touch review's.
    const failedReview = [
      { stageKey: 'uat', status: 'passed', endedAt: '2026-07-30T09:00:00.000Z', attempt: 0 },
      { stageKey: 'review', status: 'failed', endedAt: '2026-07-30T10:00:00.000Z', attempt: 2 },
    ];
    expect(
      fixResumeDecision(failedReview, manifest({}, { uat: uat({ maxFixAttempts: 1 }) })),
    ).toEqual({ kind: 'resume', gate: 'review', attempts: 2 });
  });

  it('honours review.maxFixAttempts for the review budget', () => {
    const failedReview = [
      { stageKey: 'uat', status: 'passed', endedAt: '2026-07-30T09:00:00.000Z', attempt: 0 },
      { stageKey: 'review', status: 'failed', endedAt: '2026-07-30T10:00:00.000Z', attempt: 1 },
    ];
    expect(
      fixResumeDecision(failedReview, manifest({}, { review: review({ maxFixAttempts: 1 }) })),
    ).toEqual({ kind: 'exhausted', gate: 'review', attempts: 1, cap: 1 });
  });

  it('leaves uat on the default cap when review.maxFixAttempts is lowered', () => {
    // The reverse direction of the test above: narrowing review's budget must
    // not narrow uat's.
    const failedUat = [
      { stageKey: 'uat', status: 'failed', endedAt: '2026-07-30T10:00:00.000Z', attempt: 2 },
      { stageKey: 'review', status: 'passed', endedAt: '2026-07-30T09:00:00.000Z', attempt: 0 },
    ];
    expect(
      fixResumeDecision(failedUat, manifest({}, { review: review({ maxFixAttempts: 1 }) })),
    ).toEqual({ kind: 'resume', gate: 'uat', attempts: 2 });
  });

  it('does not let review failures exhaust the uat budget', () => {
    // Summed this is 4, over the cap of 3; per-stage it is 2, which still has a
    // resume left. That difference is the bug this replaces. Review is `failed`
    // here — a passing review would make the point vacuously.
    const bothFailed = [
      { stageKey: 'uat', status: 'failed', endedAt: '2026-07-30T10:00:00.000Z', attempt: 2 },
      { stageKey: 'review', status: 'failed', endedAt: '2026-07-30T09:00:00.000Z', attempt: 2 },
    ];
    expect(fixResumeDecision(bothFailed, undefined)).toEqual({
      kind: 'resume', gate: 'uat', attempts: 2,
    });
  });

  it('reports no failed gate when nothing sent the ticket to fix', () => {
    expect(
      fixResumeDecision([{ stageKey: 'uat', status: 'passed', endedAt: null, attempt: 0 }], undefined),
    ).toEqual({ kind: 'no-failed-gate' });
  });
});

/** A git runner that reports a clean, unchanged worktree without touching disk. */
const cleanGit: GitRunner = async () => ({ exitCode: 0, stdout: '', stderr: '' });

describe('driveTicket', () => {
  let store: Store;
  let id: number;
  let workDir: string;
  let artifactDir: string;
  let logs: string[];
  let resumed: { ticketId: number; gate: string; attempts: number; roundId: number | null }[];
  let worktreeLookups: number;
  let polls: number;
  let stopped: boolean;

  function deps(over: Partial<DriveTicketDeps> = {}): DriveTicketDeps {
    return {
      store,
      manifest: () => undefined,
      artifactDirFor: () => artifactDir,
      worktreeFor: () => {
        worktreeLookups += 1;
        return workDir;
      },
      onProgress: () => {},
      // Bounded so a driver that re-spins over a stage it should have rested at
      // FAILS rather than hangs: an unbroken await chain starves the timers
      // vitest times a test out with, so a livelock reports nothing at all. No
      // healthy run below polls more than twice.
      shouldContinue: () => !stopped && (polls += 1) <= 4,
      resumeFix: (ticketId, gate, attempts, roundId) =>
        resumed.push({ ticketId, gate, attempts, roundId }),
      log: (m) => logs.push(m),
      ...over,
    };
  }

  function registerWorktree(repoPath: string, path: string): void {
    store.db
      .prepare(
        `INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref, deps_mode)
         VALUES (?, ?, ?, 'karst/x', 'develop', 'inherited')`,
      )
      .run(id, repoPath, path);
  }

  beforeEach(() => {
    store = openStore(':memory:');
    id = createTicketFlow(store, { key: 'T-1', title: 't' }).id;
    transition(store, id, 'scope', { kind: 'passed' }); // -> impl
    transition(store, id, 'impl', { kind: 'passed' }); // -> uat
    workDir = mkdtempSync(join(tmpdir(), 'karst-drive-'));
    artifactDir = mkdtempSync(join(tmpdir(), 'karst-drive-art-'));
    logs = [];
    resumed = [];
    worktreeLookups = 0;
    polls = 0;
    stopped = false;
  });

  afterEach(() => {
    store.close();
    rmSync(workDir, { recursive: true, force: true });
    rmSync(artifactDir, { recursive: true, force: true });
  });

  it('parks the ticket where the real runner blocked, without transitioning or looping', async () => {
    // Nothing is faked below runStageDriver: the real `runUat` probes a real
    // package.json that defines none of the gate scripts, so this is the whole
    // wire — runner block -> durable park -> driver blocked branch.
    writeFileSync(join(workDir, 'package.json'), JSON.stringify({ scripts: { build: 'tsc' } }));

    const outcome = await driveTicket(deps(), id);

    expect(outcome.stage).toBe('uat');
    expect(outcome.status).toBe('blocked');
    expect(outcome.reason).toMatch(/^nothing-to-run: /);
    // No transition and no attempt: a block is not a verdict about the code.
    const uatStage = getTicket(store, id).stages.find((s) => s.stageKey === 'uat')!;
    expect(getTicket(store, id).stageCurrent).toBe('uat');
    expect(uatStage.attempt).toBe(0);
    expect(stageBlock(store, id, 'uat')?.kind).toBe('nothing-to-run');
    // One pass through the loop — a blocked stage that re-spun would look up the
    // worktree again and re-run the same failing gate forever.
    expect(worktreeLookups).toBe(1);
    expect(resumed).toEqual([]);
    expect(logs.some((l) => l.includes('nothing-to-run'))).toBe(true);
  });

  it('keeps the parked ticket out of the next activation sweep', async () => {
    writeFileSync(join(workDir, 'package.json'), JSON.stringify({ scripts: { build: 'tsc' } }));
    await driveTicket(deps(), id);

    const t = getTicket(store, id);
    expect(ticketsToSweep([{ id: t.id, stageCurrent: t.stageCurrent, stages: t.stages }])).toEqual([]);
  });

  it('parks when a manifest is present and no worktree maps to it', async () => {
    // The behaviour change this wiring locks in: with a manifest, UAT plans its
    // own targets, so an unmapped worktree parks instead of silently running
    // against whatever `worktreeFor` happened to return.
    registerWorktree('/not/in/manifest', workDir);
    const m = manifest({ web: repo({ repoPath: '/repo/web' }) });
    let sawManifest: boolean | undefined;

    const outcome = await driveTicket(deps({ manifest: () => m }), id, {
      runUat: (s, opts) => {
        sawManifest = opts.manifest !== undefined;
        return runUat(s, opts, { git: cleanGit });
      },
    });

    expect(sawManifest).toBe(true);
    expect(outcome.status).toBe('blocked');
    expect(outcome.reason).toContain('nothing-to-run');
    expect(outcome.reason).toContain('/not/in/manifest');
    expect(getTicket(store, id).stageCurrent).toBe('uat');
  });

  it('resumes the agent into fix against the gate that failed', async () => {
    const outcome = await driveTicket(deps(), id, {
      runUat: async (s, opts) => ({
        kind: 'advanced',
        next: transition(s, opts.ticketId, 'uat', { kind: 'failed', reason: 'exit 1' }),
      }),
    });

    expect(outcome).toEqual({ stage: 'fix', status: 'blocked', reason: 'gate-failed' });
    // No committed round (the failure above bypassed the recovery-trigger seam),
    // so the driver falls back to the stages-attempt decision, roundId null.
    expect(resumed).toEqual([{ ticketId: id, gate: 'uat', attempts: 1, roundId: null }]);
  });

  it('resumes against the COMMITTED recovery round, carrying its id and committed cap', async () => {
    // A real failed verdict commits round 1 with maxRounds 3.
    const round = openRecoveryRound(store, {
      ticketId: id, sourceStage: 'uat', sourceProcessId: 'gates',
      sourceStageRunId: null, sourceProcessRunId: null,
      triggerKind: 'gate-failure', triggerDetail: 'exit 1', maxRounds: 3,
      startedAt: '2026-08-01T10:00:00.000Z',
    });
    transition(store, id, 'uat', { kind: 'failed', reason: 'exit 1' }); // -> fix

    const outcome = await driveTicket(deps(), id);

    expect(outcome).toEqual({ stage: 'fix', status: 'blocked', reason: 'gate-failed' });
    expect(resumed).toEqual([{ ticketId: id, gate: 'uat', attempts: 1, roundId: round.id }]);
  });

  it('stops resuming once the COMMITTED round budget is spent, whatever the live manifest says', async () => {
    // Round 2 of 2 is exhausted — and a manifest edited since the failure to
    // allow 5 must not widen the committed cap.
    openRecoveryRound(store, {
      ticketId: id, sourceStage: 'uat', sourceProcessId: 'gates',
      sourceStageRunId: null, sourceProcessRunId: null,
      triggerKind: 'gate-failure', triggerDetail: 'exit 1', maxRounds: 2,
      startedAt: '2026-08-01T10:00:00.000Z',
    });
    openRecoveryRound(store, {
      ticketId: id, sourceStage: 'uat', sourceProcessId: 'gates',
      sourceStageRunId: null, sourceProcessRunId: null,
      triggerKind: 'gate-failure', triggerDetail: 'exit 2', maxRounds: 2,
      startedAt: '2026-08-01T11:00:00.000Z',
    });
    transition(store, id, 'uat', { kind: 'failed', reason: 'exit 2' }); // -> fix
    const m = manifest({}, { uat: uat({ maxFixAttempts: 5 }) });

    const outcome = await driveTicket(deps({ manifest: () => m }), id);

    expect(outcome.stage).toBe('fix');
    expect(resumed).toEqual([]);
    expect(logs.some((l) => l.includes('at the cap of 2'))).toBe(true);
  });

  it('leaves a fix already in flight alone — no second resume for a fixing round', async () => {
    openRecoveryRound(store, {
      ticketId: id, sourceStage: 'uat', sourceProcessId: 'gates',
      sourceStageRunId: null, sourceProcessRunId: null,
      triggerKind: 'gate-failure', triggerDetail: 'exit 1', maxRounds: 3,
      startedAt: '2026-08-01T10:00:00.000Z',
    });
    store.db
      .prepare("UPDATE recovery_rounds SET status = 'fixing' WHERE ticket_id = ?")
      .run(id);
    transition(store, id, 'uat', { kind: 'failed', reason: 'exit 1' }); // -> fix

    const outcome = await driveTicket(deps(), id);

    expect(outcome.stage).toBe('fix');
    expect(resumed).toEqual([]);
    expect(logs.some((l) => l.includes('already in flight'))).toBe(true);
  });

  it('stops resuming once that gate’s fix budget is spent', async () => {
    // One uat failure with a cap of one: the ticket rests at fix, unswept, with
    // no new state — exhaustion needs none.
    transition(store, id, 'uat', { kind: 'failed', reason: 'exit 1' }); // -> fix, attempt 1
    const m = manifest({}, { uat: uat({ maxFixAttempts: 1 }) });

    const outcome = await driveTicket(deps({ manifest: () => m }), id);

    expect(outcome.stage).toBe('fix');
    expect(resumed).toEqual([]);
    expect(logs.some((l) => l.includes('at the cap of 1'))).toBe(true);
  });

  it('says so, and resumes nothing, when a ticket rests at fix with no failed gate', async () => {
    transition(store, id, 'uat', { kind: 'passed' }); // -> review
    transition(store, id, 'review', { kind: 'failed', reason: 'x' }); // -> fix
    // Clear the only failure so the stage rows no longer explain the fix.
    store.db.prepare("UPDATE stages SET status = 'passed' WHERE ticket_id = ?").run(id);

    const outcome = await driveTicket(deps(), id);

    expect(outcome.stage).toBe('fix');
    expect(resumed).toEqual([]);
    expect(logs.some((l) => l.includes('no failed gate'))).toBe(true);
  });

  it('aborts the gate in flight when the host signal fires', async () => {
    const host = new AbortController();
    let runSignal: AbortSignal | undefined;
    let started!: () => void;
    const hasStarted = new Promise<void>((r) => {
      started = r;
    });

    const promise = driveTicket(deps({ signal: host.signal }), id, {
      runUat: (_s, opts) => {
        runSignal = opts.signal;
        started();
        return new Promise<StageRunResult>((resolve) => {
          opts.signal?.addEventListener('abort', () => resolve({ kind: 'stopped' }), { once: true });
        });
      },
    });

    await hasStarted;
    // The signal must exist and still be live: a run that handed the gate no
    // signal, or a pre-aborted one, cannot be stopped mid-flight.
    expect(runSignal).toBeDefined();
    expect(runSignal!.aborted).toBe(false);
    host.abort();

    expect(await promise).toEqual({ stage: 'uat', status: 'stopped' });
    expect(runSignal!.aborted).toBe(true);
  });

  it('aborts the run signal when Stop lands at a stage boundary', async () => {
    let runSignal: AbortSignal | undefined;

    const outcome = await driveTicket(deps(), id, {
      runUat: async (s, opts) => {
        runSignal = opts.signal;
        stopped = true; // Stop pressed while uat ran; review must never spawn.
        return { kind: 'advanced', next: transition(s, opts.ticketId, 'uat', { kind: 'passed' }) };
      },
      runReview: async () => {
        throw new Error('review must not run after Stop');
      },
    });

    expect(outcome).toEqual({ stage: 'review', status: 'stopped' });
    expect(runSignal?.aborted).toBe(true);
  });

  it('passes the host openDiff to the review runner', async () => {
    let receivedOpenDiff: unknown;
    const hostOpenDiff = (): void => {};

    await driveTicket(deps({ openDiff: hostOpenDiff }), id, {
      runUat: async (s, opts) => ({
        kind: 'advanced',
        next: transition(s, opts.ticketId, 'uat', { kind: 'passed' }),
      }),
      runReview: async (s, opts, deps) => {
        receivedOpenDiff = deps?.openDiff;
        return { kind: 'advanced', next: transition(s, opts.ticketId, 'review', { kind: 'passed' }) };
      },
    });

    expect(receivedOpenDiff).toBe(hostOpenDiff);
  });

  it('leaves the review runner’s openDiff undefined when the host supplied none', async () => {
    let receivedOpenDiff: unknown = 'unset';

    await driveTicket(deps(), id, {
      runUat: async (s, opts) => ({
        kind: 'advanced',
        next: transition(s, opts.ticketId, 'uat', { kind: 'passed' }),
      }),
      runReview: async (s, opts, deps) => {
        receivedOpenDiff = deps?.openDiff;
        return { kind: 'advanced', next: transition(s, opts.ticketId, 'review', { kind: 'passed' }) };
      },
    });

    expect(receivedOpenDiff).toBeUndefined();
  });

  // G6: review parks, stops and states its verdict itself now, so it needs the
  // same one-controller-per-run signal uat gets — without it a Stop pressed
  // during a fifteen-minute review gate is only noticed once that gate finishes.
  it('threads the run signal into the review runner too', async () => {
    let reviewSignal: AbortSignal | undefined;
    let uatSignal: AbortSignal | undefined;

    await driveTicket(deps(), id, {
      runUat: async (s, opts) => {
        uatSignal = opts.signal;
        return { kind: 'advanced', next: transition(s, opts.ticketId, 'uat', { kind: 'passed' }) };
      },
      runReview: async (s, opts) => {
        reviewSignal = opts.signal;
        return { kind: 'advanced', next: transition(s, opts.ticketId, 'review', { kind: 'passed' }) };
      },
    });

    expect(reviewSignal).toBeDefined();
    expect(reviewSignal).toBe(uatSignal); // one controller for the whole run
  });

  it('does not abort the run signal on an ordinary completion', async () => {
    let runSignal: AbortSignal | undefined;

    await driveTicket(deps(), id, {
      runUat: async (s, opts) => {
        runSignal = opts.signal;
        return { kind: 'advanced', next: transition(s, opts.ticketId, 'uat', { kind: 'passed' }) };
      },
      runReview: async (s, opts) => ({
        kind: 'advanced',
        next: transition(s, opts.ticketId, 'review', { kind: 'passed' }), // -> ship
      }),
    });

    expect(runSignal?.aborted).toBe(false);
  });

  it('threads onGateComplete to the uat runner, wired to onProgress', async () => {
    let receivedOnGateComplete: unknown = 'unset';
    const progressCalls: string[] = [];

    await driveTicket(deps({ onProgress: (_id, stage, status) => progressCalls.push(`${stage}:${status}`) }), id, {
      runUat: async (s, opts) => {
        receivedOnGateComplete = opts.onGateComplete;
        // Simulate a gate completing by invoking the callback.
        opts.onGateComplete?.('test');
        return { kind: 'advanced', next: transition(s, opts.ticketId, 'uat', { kind: 'passed' }) };
      },
      runReview: async (s, opts) => ({
        kind: 'advanced',
        next: transition(s, opts.ticketId, 'review', { kind: 'passed' }),
      }),
    });

    expect(receivedOnGateComplete).toBeTypeOf('function');
    expect(progressCalls).toContain('uat:running');
  });

  it('threads onGateComplete to the review runner', async () => {
    let receivedOnGateComplete: unknown = 'unset';

    await driveTicket(deps(), id, {
      runUat: async (s, opts) => ({
        kind: 'advanced',
        next: transition(s, opts.ticketId, 'uat', { kind: 'passed' }),
      }),
      runReview: async (s, opts) => {
        receivedOnGateComplete = opts.onGateComplete;
        return { kind: 'advanced', next: transition(s, opts.ticketId, 'review', { kind: 'passed' }) };
      },
    });

    expect(receivedOnGateComplete).toBeTypeOf('function');
  });

  // Task 8 production boundary: the host resolves the Tester/Review process
  // assignments and the verifier gate runner; the driver must thread them into
  // the real runners, resolving each process EXACTLY once (the host's resolver
  // builds a fresh instrumented adapter per call, so a second call would
  // instrument twice).
  it('resolves the Tester and Review processes once and threads them, with the verifier runner, into the real runners', async () => {
    const adapterA: AgentAdapter = {
      requiredBinary: 'fake',
      capabilities: { lifecycleEvents: false, resume: false },
      buildInteractiveCommand: () => ({ command: 'fake', args: [], env: {} }),
      runHeadless: async () => ({ sessionId: '', verdict: null, raw: '[]' }),
    };
    const adapterB: AgentAdapter = { ...adapterA };
    const resolveUatTester = vi.fn(() => ({
      assignment: { agentName: 'UAT Agent', provider: 'claude' as const },
      adapter: adapterA,
    }));
    const resolveReviewProcess = vi.fn(() => ({
      assignment: { agentName: 'Review Agent', provider: 'codex' as const },
      adapter: adapterB,
    }));
    const runVerifier = vi.fn(async () => ({ kind: 'completed' as const, exitCode: 0, output: '' }));
    let seenUatDeps: UatDeps | undefined;
    let seenReviewDeps: ReviewDeps | undefined;

    const outcome = await driveTicket(
      deps({
        uatTester: resolveUatTester,
        reviewProcess: resolveReviewProcess,
        runVerifier: runVerifier as unknown as typeof runProcess,
      }),
      id,
      {
        runUat: async (s, opts, runnerDeps) => {
          seenUatDeps = runnerDeps;
          return { kind: 'advanced', next: transition(s, opts.ticketId, 'uat', { kind: 'passed' }) };
        },
        runReview: async (s, opts, runnerDeps) => {
          seenReviewDeps = runnerDeps;
          return { kind: 'advanced', next: transition(s, opts.ticketId, 'review', { kind: 'passed' }) };
        },
      },
    );

    expect(outcome.stage).toBe('ship');
    expect(resolveUatTester).toHaveBeenCalledTimes(1);
    expect(resolveReviewProcess).toHaveBeenCalledTimes(1);
    expect(seenUatDeps?.tester).toEqual({
      assignment: { agentName: 'UAT Agent', provider: 'claude' },
      adapter: adapterA,
    });
    expect(seenUatDeps?.runVerifier).toBe(runVerifier);
    expect(seenReviewDeps?.reviewProcess).toEqual({
      assignment: { agentName: 'Review Agent', provider: 'codex' },
      adapter: adapterB,
    });
    // The review runner's findings adapter is the SAME instrumented adapter the
    // process resolved — no second resolution path to keep in sync.
    expect(seenReviewDeps?.findingsAdapter).toBe(adapterB);
  });

  // The composition-seam evidence: driving the REAL runUat through driveTicket
  // with a Tester wired must use the opened Tester process id for the
  // observations it records, and the ticket must progress on its gates alone.
  it('uses the opened Tester process id for findings at the real composition boundary', async () => {
    writeFileSync(join(workDir, 'package.json'), JSON.stringify({ scripts: { test: 'true' } }));
    const adapter: AgentAdapter = {
      requiredBinary: 'fake',
      capabilities: { lifecycleEvents: false, resume: false },
      buildInteractiveCommand: () => ({ command: 'fake', args: [], env: {} }),
      runHeadless: async () => ({
        sessionId: '',
        verdict: null,
        raw: JSON.stringify([{ severity: 'high', title: 'login broken', detail: '' }]),
      }),
    };

    const outcome = await driveTicket(
      deps({
        uatTester: () => ({ assignment: { agentName: 'UAT Agent', provider: 'claude' }, adapter }),
        reviewProcess: () => ({
          assignment: { agentName: 'Review Agent', provider: 'claude' },
          adapter,
        }),
      }),
      id,
    );

    expect(outcome.stage).toBe('review'); // uat passed on its gates, review parked
    const testerRun = listProcessRuns(store, id).find((r) => r.processId === 'tester')!;
    expect(testerRun.resultKind).toBe('observed');
    expect(listUatFindings(store, id)).toHaveLength(1);
    expect(listUatFindings(store, id)[0]!.processRunId).toBe(testerRun.id);
  });
});
