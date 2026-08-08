import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { createTicketFlow } from './stages/create.js';
import { getTicket } from '../store/tickets.js';
import { transition } from './machine.js';
import { runFix } from './stages/fix.js';
import { openGateRun } from './gates/evidence.js';
import { commitGateOutcome } from './gates/commit.js';
import { listProcessRuns } from '../store/processRuns.js';
import {
  listRecoveryRounds,
  completeRevalidation,
} from '../store/recoveryRounds.js';
import { markFixDone, resumeFixExecution, type FixTransition } from './fixExecution.js';
import type { AgentAdapter } from '../agent/adapter.js';

const now = () => '2026-08-01T10:00:00.000Z';
const T1 = '2026-08-01T11:00:00.000Z';
const T2 = '2026-08-01T12:00:00.000Z';

/** Fail uat through the REAL commit seam so the recovery round is opened atomically. */
function failUat(store: Store, id: number, reason = 'exit 1'): number {
  const runAt = now();
  const evidence = openGateRun(store, { ticketId: id, stageKey: 'uat', runAt });
  commitGateOutcome(store, {
    ticketId: id,
    stageKey: 'uat',
    runAt,
    artifactPath: '/art/uat.log',
    gates: [],
    outcome: { kind: 'verdict', verdict: { kind: 'failed', reason } },
    stageRunId: evidence.runId,
    recoveryTrigger: {
      sourceProcessId: 'gates',
      sourceStageRunId: evidence.runId,
      sourceProcessRunId: null,
      triggerKind: 'gate-failure',
      triggerDetail: reason,
      maxRounds: 3,
    },
    now,
  });
  return evidence.runId;
}

describe('markFixDone — the stage fix pass marker', () => {
  let store: Store;
  let id: number;

  beforeEach(() => {
    store = openStore(':memory:');
    id = createTicketFlow(store, { key: 'T-1', title: 't' }).id;
    transition(store, id, 'scope', { kind: 'passed' });
    transition(store, id, 'impl', { kind: 'passed' });
  });
  afterEach(() => store.close());

  it('atomically passes the fix process run, moves the round to revalidating and follows fix -> uat', () => {
    failUat(store, id);
    // A live-session nudge opened the fix execution before the brief was delivered.
    store.db
      .prepare(
        `INSERT INTO process_runs (ticket_id, stage_key, process_id, attempt, status, started_at)
         VALUES (?, 'fix', 'fix', 0, 'running', ?)`,
      )
      .run(id, T1);
    const runId = Number(
      (store.db.prepare('SELECT MAX(id) AS m FROM process_runs').get() as { m: number }).m,
    );
    store.db
      .prepare("UPDATE recovery_rounds SET fix_process_run_id = ?, status = 'fixing' WHERE id = ?")
      .run(runId, listRecoveryRounds(store, id)[0]!.id);

    const next = markFixDone(store, id);

    expect(next).toBe('uat');
    expect(getTicket(store, id).stageCurrent).toBe('uat');
    expect(listProcessRuns(store, id)[0]!.status).toBe('passed');
    expect(listProcessRuns(store, id)[0]!.endedAt).not.toBeNull();
    const round = listRecoveryRounds(store, id)[0]!;
    expect(round.status).toBe('revalidating');
    expect(round.fixProcessRunId).toBe(runId);
  });

  it('a rejected stale marker mutates neither the run, the round nor the stage', () => {
    failUat(store, id);
    const roundBefore = listRecoveryRounds(store, id)[0]!;
    const runBefore = listProcessRuns(store, id).length;

    // The ticket already left fix — the marker is stale.
    transition(store, id, 'fix', { kind: 'passed' });
    expect(() => markFixDone(store, id)).toThrow(/current stage/);

    expect(getTicket(store, id).stageCurrent).toBe('uat');
    expect(listRecoveryRounds(store, id)[0]).toEqual(roundBefore);
    expect(listProcessRuns(store, id)).toHaveLength(runBefore);
  });

  it('passes the completion premutate to the injected transition', () => {
    const calls: unknown[] = [];
    const fake: FixTransition = (s, t, from, verdict, premutate) => {
      calls.push({ from, verdict, premutate: typeof premutate });
      premutate?.();
      return 'uat';
    };
    expect(markFixDone(store, id, fake)).toBe('uat');
    expect(calls).toEqual([{ from: 'fix', verdict: { kind: 'passed' }, premutate: 'function' }]);
  });

  it('is a no-op for a ticket at fix with no active round — pre-v30 tickets transition untracked', () => {
    transition(store, id, 'uat', { kind: 'failed', reason: 'boom' }); // -> fix, no round
    const next = markFixDone(store, id);
    expect(next).toBe('uat');
    expect(listRecoveryRounds(store, id)).toEqual([]);
  });
});

describe('resumeFixExecution — driver -> agent handoff', () => {
  let store: Store;
  let id: number;

  beforeEach(() => {
    store = openStore(':memory:');
    id = createTicketFlow(store, { key: 'T-1', title: 't' }).id;
    transition(store, id, 'scope', { kind: 'passed' });
    transition(store, id, 'impl', { kind: 'passed' });
  });
  afterEach(() => store.close());

  function roundId(): number {
    failUat(store, id);
    return listRecoveryRounds(store, id)[0]!.id;
  }

  it('a live-session nudge opens and attaches exactly one Fix process run BEFORE the prompt is delivered', () => {
    const r = roundId();
    let delivered: string | undefined;
    const sequence: string[] = [];
    const outcome = resumeFixExecution(store, {
      ticketId: id,
      roundId: r,
      identity: { provider: 'claude', model: 'opus' },
      startedAt: T1,
      prompt: 'fix it',
      isLive: () => true,
      nudge: (prompt) => {
        // Proof of ordering: at delivery time the run already exists and is attached.
        const runs = listProcessRuns(store, id);
        if (runs.length !== 1) sequence.push('missing-run');
        if (runs[0]?.processId !== 'fix') sequence.push('wrong-process');
        const round = listRecoveryRounds(store, id)[0]!;
        if (round.status !== 'fixing') sequence.push('not-fixing');
        if (round.fixProcessRunId !== runs[0]?.id) sequence.push('not-attached');
        delivered = prompt;
        return true;
      },
      open: () => {
        sequence.push('opened');
      },
    });

    expect(outcome).toBe('nudged');
    expect(delivered).toBe('fix it');
    expect(sequence).toEqual([]);
    const runs = listProcessRuns(store, id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ stageKey: 'fix', processId: 'fix', status: 'running' });
    const round = listRecoveryRounds(store, id)[0]!;
    expect(round.fixProcessRunId).toBe(runs[0]!.id);
    expect(round.status).toBe('fixing');
  });

  it('a delivery failure interrupts both the execution and the round', () => {
    const r = roundId();
    expect(() =>
      resumeFixExecution(store, {
        ticketId: id,
        roundId: r,
        identity: null,
        startedAt: T1,
        prompt: 'fix it',
        isLive: () => true,
        nudge: () => {
          throw new Error('terminal vanished');
        },
        open: () => {},
      }),
    ).toThrow(/terminal vanished/);

    expect(listProcessRuns(store, id)[0]!.status).toBe('interrupted');
    const round = listRecoveryRounds(store, id)[0]!;
    expect(round.status).toBe('interrupted');
    expect(round.endedAt).toBe(T1);
  });

  it('a closed session launches without opening the process run — the intent owns it until SessionStart', () => {
    const r = roundId();
    let opened = 0;
    const outcome = resumeFixExecution(store, {
      ticketId: id,
      roundId: r,
      identity: { provider: 'claude', model: 'opus' },
      startedAt: T1,
      prompt: 'fix it',
      isLive: () => false,
      nudge: () => {
        throw new Error('must not nudge a closed session');
      },
      open: () => {
        opened += 1;
      },
    });

    expect(outcome).toBe('launched');
    expect(opened).toBe(1);
    expect(listProcessRuns(store, id)).toHaveLength(0);
    expect(listRecoveryRounds(store, id)[0]!.status).toBe('pending');
  });

  it('a pre-round ticket resumes untracked, exactly as before', () => {
    transition(store, id, 'uat', { kind: 'failed', reason: 'boom' }); // -> fix, no round
    const nudges: string[] = [];
    const outcome = resumeFixExecution(store, {
      ticketId: id,
      roundId: null,
      identity: null,
      startedAt: T1,
      prompt: 'fix it',
      isLive: () => true,
      nudge: (prompt) => {
        nudges.push(prompt);
        return true;
      },
      open: () => {},
    });
    expect(outcome).toBe('nudged');
    expect(nudges).toEqual(['fix it']);
    expect(listProcessRuns(store, id)).toHaveLength(0);
  });
});

describe('production recovery never routes through runFix', () => {
  let store: Store;
  let id: number;

  beforeEach(() => {
    store = openStore(':memory:');
    id = createTicketFlow(store, { key: 'T-1', title: 't' }).id;
    transition(store, id, 'scope', { kind: 'passed' });
    transition(store, id, 'impl', { kind: 'passed' });
  });
  afterEach(() => store.close());

  const fakeAdapter = (): AgentAdapter => ({
    runHeadless: () => Promise.resolve({ sessionId: 's', verdict: { kind: 'passed' }, raw: '{}' }),
    buildInteractiveCommand: () => ({ command: 'claude', args: [], env: {} }),
    requiredBinary: 'claude',
    capabilities: { lifecycleEvents: true, resume: true },
  });

  it('runFix itself opens no process run and invents no round — tracking belongs to the driver/marker path', async () => {
    store.db.prepare('UPDATE tickets SET session_id = ? WHERE id = ?').run('sess-abc', id);
    failUat(store, id);
    // The headless helper re-enters uat, but the committed round is untouched:
    // no fix process run was opened, the round is still pending.
    const next = await runFix(store, { ticketId: id, cwd: '/wt' }, fakeAdapter());
    expect(next).toBe('uat');
    expect(listProcessRuns(store, id)).toHaveLength(0);
    expect(listRecoveryRounds(store, id)[0]!.status).toBe('pending');
    // The marker is what completes the round — no runFix anywhere in the loop.
    const runId = failUat(store, id); // -> fix again, round 2 (evidence run)
    expect(runId).toBeGreaterThan(0);
  });

  it('the full production loop — failure, nudge execution, marker, revalidation — never calls runFix', () => {
    const firstRound = (() => {
      failUat(store, id);
      return listRecoveryRounds(store, id)[0]!;
    })();
    store.db
      .prepare(
        `INSERT INTO process_runs (ticket_id, stage_key, process_id, attempt, status, started_at)
         VALUES (?, 'fix', 'fix', 0, 'running', ?)`,
      )
      .run(id, T1);
    const fixRunId = Number(
      (store.db.prepare('SELECT MAX(id) AS m FROM process_runs').get() as { m: number }).m,
    );
    store.db
      .prepare(
        `UPDATE recovery_rounds SET fix_process_run_id = ?, status = 'fixing' WHERE id = ?`,
      )
      .run(fixRunId, firstRound.id);

    markFixDone(store, id); // -> uat
    expect(listRecoveryRounds(store, id)[0]!.status).toBe('revalidating');

    // The revalidation UAT run passes through the real commit seam.
    const runAt = now();
    const evidence = openGateRun(store, { ticketId: id, stageKey: 'uat', runAt });
    commitGateOutcome(store, {
      ticketId: id,
      stageKey: 'uat',
      runAt,
      artifactPath: '/art/uat.log',
      gates: [],
      outcome: { kind: 'verdict', verdict: { kind: 'passed' } },
      stageRunId: evidence.runId,
      now,
    });
    completeRevalidation(store, { ticketId: id, stageKey: 'uat', stageRunId: evidence.runId, endedAt: T2 });

    expect(listRecoveryRounds(store, id)[0]!.status).toBe('passed');
    expect(getTicket(store, id).stageCurrent).toBe('review');
  });
});
