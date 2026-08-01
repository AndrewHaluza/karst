import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../store/db.js';
import { getTicket } from '../store/tickets.js';
import { stageBlock } from '../store/stageBlocks.js';
import { transition } from './machine.js';
import { createTicketFlow } from './stages/create.js';
import { ticketsToSweep } from './driverController.js';
import { manifest, repo, uat } from '../manifest/fixtures.js';
import type { GitRunner } from '../integrations/git.js';
import type { StageRunResult } from '../model/types.js';
import { runUat } from './stages/uat.js';
import { driveTicket, fixResumeDecision, type DriveTicketDeps } from './driveTicket.js';

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
    // The uat knob must not narrow review's budget: review's redesign (and its
    // own cap) is out of scope, so it stays on FIX_ATTEMPT_CAP.
    const failedReview = [
      { stageKey: 'uat', status: 'passed', endedAt: '2026-07-30T09:00:00.000Z', attempt: 0 },
      { stageKey: 'review', status: 'failed', endedAt: '2026-07-30T10:00:00.000Z', attempt: 2 },
    ];
    expect(
      fixResumeDecision(failedReview, manifest({}, { uat: uat({ maxFixAttempts: 1 }) })),
    ).toEqual({ kind: 'resume', gate: 'review', attempts: 2 });
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
  let resumed: { ticketId: number; gate: string; attempts: number }[];
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
      resumeFix: (ticketId, gate, attempts) => resumed.push({ ticketId, gate, attempts }),
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
    expect(resumed).toEqual([{ ticketId: id, gate: 'uat', attempts: 1 }]);
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

  it('does not abort the run signal on an ordinary completion', async () => {
    let runSignal: AbortSignal | undefined;

    await driveTicket(deps(), id, {
      runUat: async (s, opts) => {
        runSignal = opts.signal;
        return { kind: 'advanced', next: transition(s, opts.ticketId, 'uat', { kind: 'passed' }) };
      },
      runReview: async (s, opts) => {
        transition(s, opts.ticketId, 'review', { kind: 'passed' }); // -> ship
        return { verdict: { kind: 'passed' }, artifactPath: '/x', gates: [] };
      },
    });

    expect(runSignal?.aborted).toBe(false);
  });
});
