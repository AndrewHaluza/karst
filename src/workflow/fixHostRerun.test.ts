import { describe, it, expect, beforeEach } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { createTicketFlow } from './stages/create.js';
import { openProcessRun } from '../store/processRuns.js';
import { openRecoveryRound, activeFixRound, roundById } from '../store/recoveryRounds.js';
import { recordGateRun } from '../store/gateRuns.js';
import { hasFixingRound } from '../store/recoveryRoundsRead.js';
import { resetStageState } from './resetStage.js';
import { getStage, setStage } from '../store/stages.js';
import { setStageCurrent, getTicket } from '../store/tickets.js';
import {
  hostRerunFailedGates,
  describeHostRerun,
  HOST_RERUN_PASSED_REASON,
  HOST_RERUN_WAY_OUT,
  type FailedGate,
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
    runGate: async (_id, gate) => {
      ran.push(gate);
      return result(gate);
    },
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

  it('ends the round fix process run when the re-run passes, marked as closed by the host', async () => {
    const run = openProcessRun(store, { ticketId, stageKey: 'fix', processId: 'fix', attempt: 1, startedAt: AT } as never);
    store.db.prepare('UPDATE recovery_rounds SET fix_process_run_id = ?, status = ? WHERE id = ?').run(run.id, 'fixing', roundId);
    await hostRerunFailedGates(store, ticketId, deps(() => ok));
    const row = store.db.prepare('SELECT status, ended_at, result_kind FROM process_runs WHERE id = ?').get(run.id) as Record<string, string>;
    expect(row).toMatchObject({ status: 'interrupted', ended_at: '2026-01-02T00:00:00Z', result_kind: 'host-rerun-passed' });
  });

  it('keeps the refusal, parks the fix stage with names and summaries when a gate still fails', async () => {
    const out = await hostRerunFailedGates(
      store,
      ticketId,
      deps((g) => (g.gateName === 'unit (web)' ? ok : { exitCode: 1, summary: 'port 3000 busy' })),
    );
    expect(out).toEqual({ kind: 'failed', failures: [{ gateName: 'e2e (api)', summary: 'port 3000 busy' }] });
    expect(getTicket(store, ticketId).stageCurrent).toBe('fix');
    const fix = getStage(store, ticketId, 'fix');
    expect(fix?.status).toBe('failed');
    expect(fix?.verdict).toContain('e2e (api)');
    expect(fix?.verdict).toContain('port 3000 busy');
    expect(roundById(store, roundId)?.status).toBe('pending');
    expect(fix?.verdict).toContain('Reset stage');
  });

  it('moves a fixing round out of the in-flight set: reset available, no pending marker', async () => {
    store.db.prepare("UPDATE recovery_rounds SET status = 'fixing' WHERE id = ?").run(roundId);
    await hostRerunFailedGates(store, ticketId, deps(() => ({ exitCode: 1, summary: 'x' })));
    const row = store.db.prepare('SELECT status, end_reason FROM recovery_rounds WHERE id = ?').get(roundId) as Record<string, string>;
    expect(row.status).not.toBe('fixing');
    expect(row.end_reason).toContain('Reset stage');
    expect(hasFixingRound(store, ticketId)).toBe(false);
    expect(resetStageState(store, ticketId)).toEqual({ available: true, stage: 'uat' });
  });

  it('the already-used path also leaves the fixing state', async () => {
    store.db.prepare("UPDATE recovery_rounds SET status = 'fixing', host_rerun_at = ? WHERE id = ?").run(AT, roundId);
    const out = await hostRerunFailedGates(store, ticketId, deps(() => ok));
    expect(out).toEqual({ kind: 'already-used' });
    expect(hasFixingRound(store, ticketId)).toBe(false);
    expect(resetStageState(store, ticketId)).toEqual({ available: true, stage: 'uat' });
    expect(describeHostRerun(out)?.message).toContain('Reset stage');
  });

  it('never re-runs a second time in the same round', async () => {
    await hostRerunFailedGates(store, ticketId, deps(() => ({ exitCode: 1, summary: 'x' })));
    ran = [];
    const again = await hostRerunFailedGates(store, ticketId, deps(() => ok));
    expect(again).toEqual({ kind: 'already-used' });
    expect(ran).toEqual([]);
  });

  it('counts a gate that cannot answer (null exit) or throws as still failing', async () => {
    let n = 0;
    const out = await hostRerunFailedGates(store, ticketId, {
      runGate: async () => {
        n += 1;
        if (n === 1) return { exitCode: null, summary: null };
        throw new Error('sandbox down');
      },
    });
    expect(out.kind).toBe('failed');
    if (out.kind === 'failed') {
      expect(out.failures.map((f) => f.gateName)).toEqual(['unit (web)', 'e2e (api)']);
      expect(out.failures[1]?.summary).toContain('sandbox down');
    }
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
  });
});
