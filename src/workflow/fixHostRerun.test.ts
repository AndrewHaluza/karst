import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { createTicketFlow } from './stages/create.js';
import { openProcessRun } from '../store/processRuns.js';
import { openRecoveryRound, activeFixRound, roundById, listRecoveryRounds, recoveryDecision } from '../store/recoveryRounds.js';
import { recordGateRun } from '../store/gateRuns.js';
import { recordFixRoundHeads } from '../store/fixRoundHeads.js';
import { hasFixingRound } from '../store/recoveryRoundsRead.js';
import { resetStageState } from './resetStage.js';
import { fixParkView } from './fixParkExit.js';
import { roundFixDecision } from './fixAttempts.js';
import { getStage, setStage } from '../store/stages.js';
import { setStageCurrent, getTicket } from '../store/tickets.js';
import { recordNoChangeReason } from '../store/fixNoChangeRounds.js';
import { claimHostRerun } from '../store/hostRerunRound.js';
import {
  hostRerunFailedGates,
  describeHostRerun,
  HOST_RERUN_PASSED_REASON,
  HOST_RERUN_WAY_OUT,
  type FailedGate,
  type GateRerunResult,
  type HostRerunDeps,
} from './fixHostRerun.js';

const AT = '2026-01-01T00:00:00Z';
const ok = { exitCode: 0, summary: null };

describe('host re-run of failed gates for a refused no-commit fix marker', () => {
  let store: Store;
  let ticketId: number;
  let roundId: number;
  let ran: FailedGate[];

  const deps = (result: (g: FailedGate) => { exitCode: number | null; summary: string | null }): HostRerunDeps => ({
    runGates: async (_id, gates) =>
      gates.map((gate) => {
        ran.push(gate);
        return result(gate);
      }),
    now: () => '2026-01-02T00:00:00Z',
  });

  beforeEach(() => {
    ran = [];
    store = openStore(':memory:');
    ticketId = createTicketFlow(store, { key: 'T-1', title: 't' }).id;
    setStage(store, ticketId, 'uat', { status: 'failed', verdict: 'gates failed', startedAt: AT, endedAt: AT, attempt: 1 });
    setStage(store, ticketId, 'fix', { status: 'running', startedAt: AT });
    setStageCurrent(store, ticketId, 'fix');
    recordGateRun(store, {
      ticketId,
      stageKey: 'uat',
      attempt: 1,
      runAt: AT,
      gates: [
        { gateName: 'unit (web)', exitCode: 1, repo: 'web', command: 'npm', args: ['run', 'test:unit'], summary: 'flaky' },
        { gateName: 'lint (web)', exitCode: 0, repo: 'web', command: 'npm', args: ['run', 'lint'] },
        { gateName: 'e2e (api)', exitCode: 137, repo: 'api', command: 'npm', args: ['run', 'e2e'], summary: 'oom' },
        { gateName: 'skipme (web)', exitCode: null, repo: 'web', command: 'npm', args: ['run', 'x'], skipped: true },
      ],
    });
    roundId = openRecoveryRound(store, {
      ticketId,
      sourceStage: 'uat',
      sourceProcessId: 'gates',
      triggerKind: 'gate-failure',
      triggerDetail: 'x',
      maxRounds: 3,
      startedAt: AT,
    } as never).id;
  });

  it('re-runs only the failed gates and closes the round passed when they all pass', async () => {
    const out = await hostRerunFailedGates(store, ticketId, deps(() => ok));
    expect(out).toEqual({ kind: 'passed', stage: 'uat' });
    expect(ran.map((g) => g.gateName)).toEqual(['unit (web)', 'e2e (api)']);
    expect(ran[0]).toMatchObject({ repo: 'web', command: 'npm', args: ['run', 'test:unit'] });
    const row = store.db
      .prepare('SELECT status, end_reason, ended_at, host_rerun_at FROM recovery_rounds WHERE id = ?')
      .get(roundId) as Record<string, string>;
    expect(row).toMatchObject({ status: 'passed', end_reason: HOST_RERUN_PASSED_REASON, host_rerun_at: '2026-01-02T00:00:00Z' });
    expect(HOST_RERUN_PASSED_REASON).toBe('no change: failed gates passed on re-run');
    expect(getTicket(store, ticketId).stageCurrent).toBe('uat');
    expect(getStage(store, ticketId, 'uat')).toMatchObject({ status: 'running', attempt: 1, blockedKind: null });
    expect(getStage(store, ticketId, 'fix')).toMatchObject({ status: 'pending' });
    expect(activeFixRound(store, ticketId)).toBeNull();
  });

  it('calls onPassed once, after the stage returned, with the ticket and the source stage', async () => {
    const seen: unknown[] = [];
    const onPassed = (id: number, stage: string, round: number) => { seen.push([id, stage, round, getStage(store, ticketId, 'uat')?.status]); };
    await hostRerunFailedGates(store, ticketId, { ...deps(() => ok), onPassed });
    expect(seen).toEqual([[ticketId, 'uat', roundId, 'running']]);
  });

  it('does not call onPassed when a gate still fails', async () => {
    const onPassed = vi.fn();
    await hostRerunFailedGates(store, ticketId, { ...deps((g) => (g.gateName === 'unit (web)' ? { exitCode: 1, summary: 'red' } : ok)), onPassed });
    expect(onPassed).not.toHaveBeenCalled();
  });

  it('logs a throw of onPassed and still reports passed', async () => {
    const debug = vi.fn();
    const out = await hostRerunFailedGates(store, ticketId, { ...deps(() => ok), debug, onPassed: () => { throw new Error('boom'); } });
    expect(out).toEqual({ kind: 'passed', stage: 'uat' });
    expect(debug).toHaveBeenCalledWith(`[fix-rerun] ticket ${ticketId}: after a passed re-run: boom`);
  });

  it('ends the round fix process run when the re-run passes, marked as closed by the host', async () => {
    const run = openProcessRun(store, { ticketId, stageKey: 'fix', processId: 'fix', attempt: 1, startedAt: AT } as never);
    store.db.prepare('UPDATE recovery_rounds SET fix_process_run_id = ?, status = ? WHERE id = ?').run(run.id, 'fixing', roundId);
    await hostRerunFailedGates(store, ticketId, deps(() => ok));
    const row = store.db.prepare('SELECT status, ended_at, result_kind FROM process_runs WHERE id = ?').get(run.id) as Record<string, string>;
    expect(row).toMatchObject({ status: 'interrupted', ended_at: '2026-01-02T00:00:00Z', result_kind: 'host-rerun-passed' });
  });

  it('opens the next round when a gate still fails at round 1 of 3, and tells the host once', async () => {
    const onNextRound = vi.fn();
    const out = await hostRerunFailedGates(
      store,
      ticketId,
      { ...deps((g) => (g.gateName === 'unit (web)' ? ok : { exitCode: 1, summary: 'port 3000 busy' })), onNextRound },
    );
    expect(out).toEqual({ kind: 'next-round', round: 2, maxRounds: 3, failures: [{ gateName: 'e2e (api)', summary: 'port 3000 busy' }] });
    expect(onNextRound).toHaveBeenCalledExactlyOnceWith(ticketId);
    expect(getTicket(store, ticketId).stageCurrent).toBe('fix');
    const fix = getStage(store, ticketId, 'fix');
    expect(fix).toMatchObject({ status: 'running', verdict: null });
    const row = store.db.prepare('SELECT status, end_reason FROM recovery_rounds WHERE id = ?').get(roundId) as Record<string, string>;
    expect(row.status).toBe('failed');
    expect(row.end_reason).toContain('gates still fail:');
    expect(row.end_reason).toContain('e2e (api)');
    expect(activeFixRound(store, ticketId)).toMatchObject({ round: 2, status: 'pending' });
    expect(fixParkView(store, ticketId)).toBeNull();
  });

  it('a throw from onNextRound goes to debug and never fails the round', async () => {
    const debug = vi.fn();
    const out = await hostRerunFailedGates(store, ticketId, {
      ...deps(() => ({ exitCode: 1, summary: 'red' })),
      debug,
      onNextRound: () => {
        throw new Error('drive gone');
      },
    });
    expect(out.kind).toBe('next-round');
    expect(debug).toHaveBeenCalledWith(`[fix-rerun] ticket ${ticketId}: after a continued round: drive gone`);
  });

  it('moves a fixing round out of the in-flight set and opens the next one', async () => {
    store.db.prepare("UPDATE recovery_rounds SET status = 'fixing' WHERE id = ?").run(roundId);
    await hostRerunFailedGates(store, ticketId, deps(() => ({ exitCode: 1, summary: 'x' })));
    const row = store.db.prepare('SELECT status, end_reason FROM recovery_rounds WHERE id = ?').get(roundId) as Record<string, string>;
    expect(row.status).not.toBe('fixing');
    expect(row.end_reason).toContain('gates still fail:');
    expect(hasFixingRound(store, ticketId)).toBe(false);
    expect(resetStageState(store, ticketId)).toEqual({ available: true, stage: 'uat' });
    expect(activeFixRound(store, ticketId)?.round).toBe(2);
  });

  it('the already-used path decides from the stored evidence and opens the next round', async () => {
    store.db.prepare("UPDATE recovery_rounds SET status = 'fixing', host_rerun_at = ? WHERE id = ?").run(AT, roundId);
    const out = await hostRerunFailedGates(store, ticketId, deps(() => ok));
    expect(out.kind).toBe('next-round');
    expect(hasFixingRound(store, ticketId)).toBe(false);
    expect(resetStageState(store, ticketId)).toEqual({ available: true, stage: 'uat' });
    expect(describeHostRerun(out)?.message).toContain('opens now');
  });

  it('a duplicate call while its re-run is in flight writes nothing and opens no round', async () => {
    store.db.prepare("UPDATE recovery_rounds SET status = 'fixing' WHERE id = ?").run(roundId);
    let release!: (results: GateRerunResult[]) => void;
    const gateRun = new Promise<GateRerunResult[]>((resolve) => {
      release = resolve;
    });
    const runGates = vi.fn(async () => gateRun);
    const first = hostRerunFailedGates(store, ticketId, { runGates, now: () => '2026-01-02T00:00:00Z' });
    const second = await hostRerunFailedGates(store, ticketId, { runGates, now: () => '2026-01-02T00:00:00Z' });
    expect(second).toEqual({ kind: 'already-used' });
    // Nothing was written by the duplicate: the round is still fixing and the claim is singular.
    expect(roundById(store, roundId)?.status).toBe('fixing');
    expect(listRecoveryRounds(store, ticketId)).toHaveLength(1);
    release([{ exitCode: 0, summary: null }, { exitCode: 0, summary: null }]);
    await first;
  });

  it('counts a gate that cannot answer (null exit) as still failing', async () => {
    const out = await hostRerunFailedGates(store, ticketId, {
      runGates: async (_id, gates) => gates.map((g) => (g.gateName === 'unit (web)' ? { exitCode: null, summary: null } : ok)),
    });
    expect(out.kind).toBe('next-round');
    if (out.kind === 'next-round') expect(out.failures.map((f) => f.gateName)).toEqual(['unit (web)']);
  });

  it('counts every gate of the set as failing when the set run throws', async () => {
    const out = await hostRerunFailedGates(store, ticketId, {
      runGates: async () => {
        throw new Error('sandbox down');
      },
    });
    expect(out.kind).toBe('next-round');
    if (out.kind === 'next-round') {
      expect(out.failures.map((f) => f.gateName)).toEqual(['unit (web)', 'e2e (api)']);
      expect(out.failures.every((f) => f.summary.includes('re-run error: sandbox down'))).toBe(true);
    }
  });

  it('routes a regenerate gate row as a composite gate, not by its label', async () => {
    recordGateRun(store, {
      ticketId, stageKey: 'uat', attempt: 1, runAt: '2026-01-01T00:00:01Z',
      gates: [{ gateName: 'regenerate (web)', exitCode: 1, repo: 'web', command: 'regenerate (web)', args: [] }],
    });
    const out = await hostRerunFailedGates(store, ticketId, deps(() => ok));
    expect(out.kind).toBe('passed');
    expect(ran).toEqual([{ gateName: 'regenerate (web)', repo: 'web', command: 'regenerate (web)', args: [], kind: 'regenerate' }]);
  });

  it('keeps a user command gate named like a regenerate gate as a command', async () => {
    recordGateRun(store, {
      ticketId, stageKey: 'uat', attempt: 1, runAt: '2026-01-01T00:00:01Z',
      gates: [{ gateName: 'regenerate (web)', exitCode: 1, repo: 'web', command: 'npm', args: ['run', 'gen'] }],
    });
    await hostRerunFailedGates(store, ticketId, deps(() => ok));
    expect(ran[0]).toMatchObject({ kind: 'command', command: 'npm' });
  });

  it('names a gate that cannot be re-run on the host and does not call it a failing gate', async () => {
    const out = await hostRerunFailedGates(store, ticketId, deps((g) => g.gateName === 'unit (web)'
      ? { exitCode: null, summary: 'unit (web) has no command the host can run', cannotRerun: true }
      : ok));
    expect(out.kind).toBe('failed');
    const reply = describeHostRerun(out)!;
    expect(reply.message).toContain('cannot be re-run on the host: unit (web)');
    expect(reply.message).not.toContain('still fail');
  });

  it('does nothing without an active round, a gate-failure trigger or a failed gate', async () => {
    store.db.prepare("UPDATE recovery_rounds SET trigger_kind = 'blocking-review-findings'").run();
    expect(await hostRerunFailedGates(store, ticketId, deps(() => ok))).toEqual({ kind: 'not-applicable' });
    store.db.prepare("UPDATE recovery_rounds SET trigger_kind = 'gate-failure', status = 'passed'").run();
    expect(await hostRerunFailedGates(store, ticketId, deps(() => ok))).toEqual({ kind: 'not-applicable' });
    store.db.prepare("UPDATE recovery_rounds SET status = 'pending'").run();
    store.db.prepare('DELETE FROM gate_runs').run();
    expect(await hostRerunFailedGates(store, ticketId, deps(() => ok))).toEqual({ kind: 'not-applicable' });
    expect(ran).toEqual([]);
  });

  it('describes each outcome for the agent', () => {
    expect(describeHostRerun({ kind: 'not-applicable' })).toBeUndefined();
    expect(describeHostRerun({ kind: 'passed', stage: 'uat' })).toEqual({
      ok: true,
      message: 'no change: failed gates passed on re-run — the ticket returned to uat',
    });
    expect(describeHostRerun({ kind: 'already-used' })).toEqual({
      ok: false,
      message: `the host already re-ran the failed gates once this fix round — the refusal stands — ${HOST_RERUN_WAY_OUT}`,
    });
    const failed = describeHostRerun({ kind: 'failed', failures: [{ gateName: 'unit (web)', summary: 'flaky' }] });
    expect(failed?.ok).toBe(false);
    expect(failed?.message).toContain('refusal stands');
    expect(failed?.message).toContain('unit (web): flaky');
    const next = describeHostRerun({ kind: 'next-round', round: 4, maxRounds: 10, failures: [{ gateName: 'unit (web)', summary: 'flaky' }] });
    expect(next?.ok).toBe(false);
    expect(next?.message).toContain('unit (web): flaky');
    expect(next?.message).toContain('fix round 4 of 10 opens now');
    expect(next?.message).toContain('stop this turn');
  });
});

describe('no-change re-run of failed gates', () => {
  let store: Store;
  let ticketId: number;
  let roundId: number;
  beforeEach(() => {
    store = openStore(':memory:');
    ticketId = createTicketFlow(store, { key: 'T-1', title: 't' }).id;
    setStage(store, ticketId, 'uat', { status: 'failed', verdict: 'gates failed', startedAt: AT, endedAt: AT, attempt: 1 });
    setStage(store, ticketId, 'fix', { status: 'running', startedAt: AT });
    setStageCurrent(store, ticketId, 'fix');
    recordGateRun(store, { ticketId, stageKey: 'uat', attempt: 1, runAt: AT, gates: [{ gateName: 'unit (web)', exitCode: 1, repo: 'web', command: 'npm', args: ['run', 'test:unit'], summary: 'x' }] });
    roundId = openRecoveryRound(store, { ticketId, sourceStage: 'uat', sourceProcessId: 'gates', triggerKind: 'gate-failure', triggerDetail: 'x', maxRounds: 3, startedAt: AT } as never).id;
    store.db.prepare("UPDATE recovery_rounds SET status = 'fixing' WHERE id = ?").run(roundId);
  });

  it('re-runs even when the D403 claim is spent, and closes with the agent reason on pass', async () => {
    claimHostRerun(store, roundId, AT);
    recordNoChangeReason(store, roundId, 'flaky port', AT);
    const out = await hostRerunFailedGates(store, ticketId, { runGates: async (_t, g) => g.map(() => ({ exitCode: 0, summary: null })), now: () => AT });
    expect(out).toEqual({ kind: 'passed', stage: 'uat' });
    expect(store.db.prepare('SELECT status, end_reason FROM recovery_rounds WHERE id = ?').get(roundId)).toEqual({ status: 'passed', end_reason: 'no change: flaky port' });
  });

  it('parks with the lead and the spent cause when the re-run fails at the last round', async () => {
    store.db.prepare('UPDATE recovery_rounds SET max_rounds = 1 WHERE id = ?').run(roundId);
    recordNoChangeReason(store, roundId, 'flaky port', AT);
    await hostRerunFailedGates(store, ticketId, { runGates: async (_t, g) => g.map(() => ({ exitCode: 1, summary: 'boom' })), now: () => AT });
    const verdict = getStage(store, ticketId, 'fix')?.verdict ?? '';
    expect(verdict).toContain('the agent found no change to make, and the re-run of the failed gates did not close the round');
    expect(verdict).toContain('the fix rounds are spent (round 1 of 1)');
    expect(verdict).not.toContain('Reset stage');
    expect(fixParkView(store, ticketId)).not.toBeNull();
  });

  it('reports already-used when the no-change re-run is claimed', async () => {
    recordNoChangeReason(store, roundId, 'r', AT);
    const deps = { runGates: async (_t: number, g: readonly FailedGate[]) => g.map(() => ({ exitCode: 1, summary: 'b' })), now: () => AT };
    await hostRerunFailedGates(store, ticketId, deps, { parkOnFailure: false });
    expect(await hostRerunFailedGates(store, ticketId, deps, { parkOnFailure: false })).toEqual({ kind: 'already-used' });
  });
});

describe('the stored host park verdict text', () => {
  let store: Store;
  let ticketId: number;
  let roundId: number;

  beforeEach(() => {
    store = openStore(':memory:');
    ticketId = createTicketFlow(store, { key: 'T-1', title: 't' }).id;
    setStage(store, ticketId, 'uat', { status: 'failed', verdict: 'gates failed', startedAt: AT, endedAt: AT, attempt: 1 });
    setStage(store, ticketId, 'fix', { status: 'running', startedAt: AT });
    setStageCurrent(store, ticketId, 'fix');
    recordGateRun(store, {
      ticketId,
      stageKey: 'uat',
      attempt: 1,
      runAt: AT,
      gates: [{ gateName: 'e2e (api)', exitCode: 1, repo: 'api', command: 'npm', args: ['run', 'e2e'], summary: 'port 3000 busy' }],
    });
    roundId = openRecoveryRound(store, {
      ticketId,
      sourceStage: 'uat',
      sourceProcessId: 'gates',
      triggerKind: 'gate-failure',
      triggerDetail: 'x',
      maxRounds: 3,
      startedAt: AT,
    } as never).id;
    store.db.prepare("UPDATE recovery_rounds SET status = 'fixing' WHERE id = ?").run(roundId);
  });

  it('parks a spent no-new-commit re-run with the already-reran lead at the cap', async () => {
    store.db.prepare("UPDATE recovery_rounds SET host_rerun_at = ?, max_rounds = 1 WHERE id = ?").run(AT, roundId);
    await hostRerunFailedGates(store, ticketId, { runGates: async () => [], now: () => AT });
    const reason = 'no new commit, and the host already re-ran the failed gates — the fix rounds are spent (round 1 of 1)';
    expect(store.db.prepare('SELECT end_reason FROM recovery_rounds WHERE id = ?').get(roundId)).toEqual({ end_reason: reason });
    expect(getStage(store, ticketId, 'fix')?.verdict).toBe(reason);
  });

  it('parks a failed no-new-commit re-run with the re-run lead at the cap', async () => {
    store.db.prepare('UPDATE recovery_rounds SET max_rounds = 1 WHERE id = ?').run(roundId);
    await hostRerunFailedGates(store, ticketId, { runGates: async (_t, g) => g.map(() => ({ exitCode: 1, summary: 'port 3000 busy' })), now: () => AT });
    const reason = 'no new commit, and the host re-run did not close the round — the fix rounds are spent (round 1 of 1)';
    expect(store.db.prepare('SELECT end_reason FROM recovery_rounds WHERE id = ?').get(roundId)).toEqual({ end_reason: reason });
    expect(getStage(store, ticketId, 'fix')?.verdict).toBe(reason);
  });

  it('parks a failed no-change re-run with the no-change lead at the cap', async () => {
    store.db.prepare('UPDATE recovery_rounds SET max_rounds = 1 WHERE id = ?').run(roundId);
    recordNoChangeReason(store, roundId, 'flaky port', AT);
    await hostRerunFailedGates(store, ticketId, { runGates: async (_t, g) => g.map(() => ({ exitCode: 1, summary: 'port 3000 busy' })), now: () => AT });
    const reason = 'the agent found no change to make, and the re-run of the failed gates did not close the round — the fix rounds are spent (round 1 of 1)';
    expect(store.db.prepare('SELECT end_reason FROM recovery_rounds WHERE id = ?').get(roundId)).toEqual({ end_reason: reason });
    expect(getStage(store, ticketId, 'fix')?.verdict).toBe(reason);
  });
});

describe('a gate that still fails continues the fix episode (T1330)', () => {
  let store: Store;
  let ticketId: number;
  const WT = '/wt/web';
  const HEADS = [{ worktreePath: WT, headSha: 'aaa' }];

  const openRound = (maxRounds = 10): number =>
    openRecoveryRound(store, {
      ticketId,
      sourceStage: 'uat',
      sourceProcessId: 'gates',
      triggerKind: 'gate-failure',
      triggerDetail: 'exit 1',
      maxRounds,
      startedAt: AT,
    } as never).id;

  /** Open `count` rounds; all earlier ones failed, the last one fixing on the given head. */
  const fixingAfter = (count: number, maxRounds = 10, head = 'aaa'): number => {
    let last = 0;
    for (let i = 0; i < count; i += 1) {
      last = openRound(maxRounds);
      recordFixRoundHeads(store, last, [{ worktreePath: WT, headSha: head }]);
      store.db.prepare('UPDATE recovery_rounds SET status = ? WHERE id = ?').run(i === count - 1 ? 'fixing' : 'failed', last);
    }
    return last;
  };

  const failDeps = (runGates = vi.fn(async (_t: number, g: readonly FailedGate[]) => g.map(() => ({ exitCode: 1, summary: 'still red' })))) =>
    ({ runGates, now: () => AT }) satisfies HostRerunDeps;

  beforeEach(() => {
    store = openStore(':memory:');
    ticketId = createTicketFlow(store, { key: 'T-1', title: 't' }).id;
    setStage(store, ticketId, 'uat', { status: 'failed', verdict: 'gates failed', startedAt: AT, endedAt: AT, attempt: 1 });
    setStage(store, ticketId, 'fix', { status: 'running', startedAt: AT });
    setStageCurrent(store, ticketId, 'fix');
    recordGateRun(store, {
      ticketId, stageKey: 'uat', attempt: 1, runAt: AT,
      gates: [{ gateName: 'unit (web)', exitCode: 1, repo: 'web', command: 'npm', args: ['run', 'test:unit'], summary: 'flaky' }],
    });
  });

  it('does not re-run the gate on a head the continued round already failed on, and opens the next round', async () => {
    const r1 = openRound();
    recordFixRoundHeads(store, r1, HEADS);
    store.db.prepare("UPDATE recovery_rounds SET status = 'failed', end_reason = 'gates still fail: unit (web)' WHERE id = ?").run(r1);
    const r2 = openRound();
    recordFixRoundHeads(store, r2, HEADS);
    store.db.prepare("UPDATE recovery_rounds SET status = 'failed', end_reason = 'gates still fail: unit (web)' WHERE id = ?").run(r2);
    const r3 = openRound();
    recordFixRoundHeads(store, r3, HEADS);
    store.db.prepare("UPDATE recovery_rounds SET status = 'failed', end_reason = 'gates still fail: unit (web)' WHERE id = ?").run(r3);
    const r4 = openRound();
    recordFixRoundHeads(store, r4, HEADS);
    store.db.prepare("UPDATE recovery_rounds SET status = 'fixing' WHERE id = ?").run(r4);
    recordNoChangeReason(store, r4, 'the gate is flaky', AT);
    const runGates = vi.fn(async (_t: number, g: readonly FailedGate[]) => g.map(() => ({ exitCode: 1, summary: 'still red' })));
    const out = await hostRerunFailedGates(store, ticketId, { runGates, now: () => AT });
    expect(out.kind).toBe('next-round');
    if (out.kind === 'next-round') expect(out.round).toBe(5);
    expect(runGates).not.toHaveBeenCalled();
  });

  it('re-runs the gates when every failed row carries an environment signature', async () => {
    store.db.prepare('DELETE FROM gate_runs').run();
    recordGateRun(store, {
      ticketId, stageKey: 'uat', attempt: 1, runAt: AT,
      gates: [{ gateName: 'unit (web)', exitCode: 1, repo: 'web', command: 'npm', args: ['run', 'test:unit'], summary: 'environment signature: a gate or test timeout\nexceeded the test timeout' }],
    });
    const r1 = openRound();
    recordFixRoundHeads(store, r1, HEADS);
    store.db.prepare("UPDATE recovery_rounds SET status = 'failed', end_reason = 'gates still fail: unit (web)' WHERE id = ?").run(r1);
    const r2 = openRound();
    recordFixRoundHeads(store, r2, HEADS);
    store.db.prepare("UPDATE recovery_rounds SET status = 'failed', end_reason = 'gates still fail: unit (web)' WHERE id = ?").run(r2);
    const r3 = openRound();
    recordFixRoundHeads(store, r3, HEADS);
    store.db.prepare("UPDATE recovery_rounds SET status = 'fixing' WHERE id = ?").run(r3);
    const runGates = vi.fn(async (_t: number, g: readonly FailedGate[]) => g.map(() => ({ exitCode: 1, summary: 'environment signature: a gate or test timeout' })));
    const out = await hostRerunFailedGates(store, ticketId, { runGates, now: () => AT });
    expect(out.kind).toBe('next-round');
    expect(runGates).toHaveBeenCalledTimes(1);
  });

  it('round 3 of 10 with a no-change marker opens round 4 in the same episode, with no park', async () => {
    const r1 = openRound();
    recordFixRoundHeads(store, r1, HEADS);
    store.db.prepare("UPDATE recovery_rounds SET status = 'failed' WHERE id = ?").run(r1);
    const r2 = openRound();
    recordFixRoundHeads(store, r2, HEADS);
    store.db.prepare("UPDATE recovery_rounds SET status = 'failed' WHERE id = ?").run(r2);
    const r3 = openRound();
    recordFixRoundHeads(store, r3, HEADS);
    store.db.prepare("UPDATE recovery_rounds SET status = 'fixing' WHERE id = ?").run(r3);
    recordNoChangeReason(store, r3, 'the port window is flaky', AT);
    const onNextRound = vi.fn();
    const out = await hostRerunFailedGates(store, ticketId, { ...failDeps(), onNextRound });
    expect(out).toMatchObject({ kind: 'next-round', round: 4, maxRounds: 10 });
    expect(onNextRound).toHaveBeenCalledExactlyOnceWith(ticketId);
    const row = store.db.prepare('SELECT status, end_reason FROM recovery_rounds WHERE id = ?').get(r3) as { status: string; end_reason: string };
    expect(row.status).toBe('failed');
    expect(row.end_reason.startsWith('gates still fail:')).toBe(true);
    const r4 = activeFixRound(store, ticketId)!;
    expect(r4).toMatchObject({ round: 4, status: 'pending' });
    expect(r4.episode).toBe(roundById(store, r3)!.episode);
    expect(getStage(store, ticketId, 'fix')).toMatchObject({ status: 'running', verdict: null });
    expect(fixParkView(store, ticketId)).toBeNull();
  });

  it('parks at once when every failure cannot be re-run on the host', async () => {
    const r1 = openRound();
    recordFixRoundHeads(store, r1, HEADS);
    store.db.prepare("UPDATE recovery_rounds SET status = 'fixing' WHERE id = ?").run(r1);
    const out = await hostRerunFailedGates(store, ticketId, {
      runGates: async (_t: number, g: readonly FailedGate[]) => g.map(() => ({ exitCode: null, summary: 'no command', cannotRerun: true as const })),
      now: () => AT,
    });
    expect(out.kind).toBe('failed');
    expect(roundById(store, r1)?.status).toBe('interrupted');
    expect(activeFixRound(store, ticketId)).toBeNull();
    expect(getStage(store, ticketId, 'fix')?.verdict).toContain('cannot be re-run on the host');
  });

  it('the 5th round on one head parks the ticket and fixParkView is set', async () => {
    const r5 = fixingAfter(5);
    const out = await hostRerunFailedGates(store, ticketId, failDeps());
    expect(out.kind).toBe('failed');
    expect(roundById(store, r5)?.status).toBe('interrupted');
    expect(getStage(store, ticketId, 'fix')?.status).toBe('failed');
    expect(fixParkView(store, ticketId)).not.toBeNull();
    expect(getStage(store, ticketId, 'fix')?.verdict).toContain('5 rounds in a row changed nothing on the same head');
  });

  it('a commit in between restarts the same-head count', async () => {
    const r1 = openRound();
    recordFixRoundHeads(store, r1, HEADS);
    store.db.prepare("UPDATE recovery_rounds SET status = 'failed' WHERE id = ?").run(r1);
    // Three rounds on a NEW head: the count is 3, not 4, so it continues.
    const r4 = fixingAfter(3, 10, 'bbb');
    const out = await hostRerunFailedGates(store, ticketId, failDeps());
    expect(out).toMatchObject({ kind: 'next-round', round: 5 });
    expect(roundById(store, r4)?.status).toBe('failed');
  });

  it('round 9 of 10 parks with the spent text and opens no round 10', async () => {
    const r9 = fixingAfter(9, 10);
    const out = await hostRerunFailedGates(store, ticketId, failDeps());
    expect(out.kind).toBe('failed');
    expect(roundById(store, r9)?.status).toBe('interrupted');
    expect(getStage(store, ticketId, 'fix')?.verdict).toBe(
      'no new commit, and the host re-run did not close the round — the fix rounds are spent (round 9 of 10)',
    );
    expect(listRecoveryRounds(store, ticketId)).toHaveLength(9);
    expect(fixParkView(store, ticketId)).not.toBeNull();
  });

  it('a bare no-commit marker after a used pre-brief re-run opens the next round', async () => {
    const r1 = openRound();
    recordFixRoundHeads(store, r1, HEADS);
    store.db.prepare("UPDATE recovery_rounds SET status = 'fixing', host_rerun_at = ? WHERE id = ?").run(AT, r1);
    const out = await hostRerunFailedGates(store, ticketId, failDeps());
    expect(out).toMatchObject({ kind: 'next-round', round: 2 });
    expect(roundById(store, r1)?.status).toBe('failed');
  });

  it('a bare no-commit marker on the same head as the continued round skips the gate and opens the next round', async () => {
    const r1 = openRound();
    recordFixRoundHeads(store, r1, HEADS);
    store.db.prepare("UPDATE recovery_rounds SET status = 'failed', end_reason = 'gates still fail: unit (web)' WHERE id = ?").run(r1);
    const r2 = openRound();
    recordFixRoundHeads(store, r2, HEADS);
    store.db.prepare("UPDATE recovery_rounds SET status = 'fixing' WHERE id = ?").run(r2);
    const runGates = vi.fn(async (_t: number, g: readonly FailedGate[]) => g.map(() => ({ exitCode: 1, summary: 'still red' })));
    const out = await hostRerunFailedGates(store, ticketId, { runGates, now: () => AT });
    expect(out).toMatchObject({ kind: 'next-round', round: 3 });
    expect(runGates).not.toHaveBeenCalled();
  });

  it('with max_rounds 3 it parks at round 2 and leaves no resumable round under a running fix row', async () => {
    const r1 = openRound(3);
    recordFixRoundHeads(store, r1, HEADS);
    store.db.prepare("UPDATE recovery_rounds SET status = 'failed', end_reason = 'gates still fail: unit (web)' WHERE id = ?").run(r1);
    const r2 = openRound(3);
    recordFixRoundHeads(store, r2, HEADS);
    store.db.prepare("UPDATE recovery_rounds SET status = 'fixing' WHERE id = ?").run(r2);
    recordNoChangeReason(store, r2, 'nothing to change', AT);
    // The driver WOULD resume this pending round, which is exactly why it must not be opened.
    expect(roundFixDecision({ roundId: r2, round: 2, maxRounds: 3 }).kind).toBe('resume');
    await hostRerunFailedGates(store, ticketId, failDeps());
    expect(roundById(store, r2)?.status).toBe('interrupted');
    expect(getStage(store, ticketId, 'fix')?.status).toBe('failed');
    expect(recoveryDecision(store, ticketId, 'uat')).toBeNull();
    expect(listRecoveryRounds(store, ticketId).filter((r) => r.status === 'pending' || r.status === 'exhausted')).toEqual([]);
  });
});
