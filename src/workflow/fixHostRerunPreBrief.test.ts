import { describe, it, expect, beforeEach } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { createTicketFlow } from './stages/create.js';
import { openRecoveryRound, activeFixRound } from '../store/recoveryRounds.js';
import { recordGateRun } from '../store/gateRuns.js';
import { setStage } from '../store/stages.js';
import { setStageCurrent, getTicket } from '../store/tickets.js';
import { preBriefHostRerun, hostRerunFailedGates, HOST_RERUN_PASSED_REASON, type FailedGate, type HostRerunDeps } from './fixHostRerun.js';

const AT = '2026-01-01T00:00:00Z';
const SIGNED = 'environment signature: a gate or test timeout\nexceeded the test timeout';

describe('pre-brief host re-run', () => {
  let store: Store;
  let ticketId: number;
  let ran: FailedGate[];

  const deps = (exitCode: number): HostRerunDeps => ({
    runGate: async (_id, gate) => {
      ran.push(gate);
      return { exitCode, summary: exitCode === 0 ? null : 'still red' };
    },
    now: () => '2026-01-02T00:00:00Z',
  });

  const open = (gates: { name: string; summary: string }[]): void => {
    createTicketRound(gates);
  };
  const createTicketRound = (gates: { name: string; summary: string }[]): void => {
    recordGateRun(store, {
      ticketId,
      stageKey: 'uat',
      attempt: 1,
      runAt: AT,
      gates: gates.map((g) => ({ gateName: g.name, exitCode: 1, repo: 'web', command: 'npm', args: ['run', g.name], summary: g.summary })),
    });
    openRecoveryRound(store, {
      ticketId,
      sourceStage: 'uat',
      sourceProcessId: 'gates',
      triggerKind: 'gate-failure',
      triggerDetail: 'x',
      maxRounds: 3,
      startedAt: AT,
    } as never);
  };

  beforeEach(() => {
    ran = [];
    store = openStore(':memory:');
    ticketId = createTicketFlow(store, { key: 'T-1', title: 't' }).id;
    setStage(store, ticketId, 'uat', { status: 'failed', verdict: 'gates failed', startedAt: AT, endedAt: AT, attempt: 1 });
    setStage(store, ticketId, 'fix', { status: 'pending' });
    setStageCurrent(store, ticketId, 'fix');
  });

  it('closes a round whose failed gates all carry a signature and pass on re-run, with no brief', async () => {
    open([{ name: 'visual', summary: SIGNED }, { name: 'integration', summary: SIGNED }]);
    const out = await preBriefHostRerun(store, ticketId, deps(0));
    expect(out).toEqual({ kind: 'passed', stage: 'uat' });
    expect(ran).toHaveLength(2);
    expect(activeFixRound(store, ticketId)).toBeNull();
    const row = store.db.prepare('SELECT status, end_reason FROM recovery_rounds').get() as Record<string, string>;
    expect(row).toEqual({ status: 'passed', end_reason: HOST_RERUN_PASSED_REASON });
    expect(getTicket(store, ticketId).stageCurrent).toBe('uat');
  });

  it('leaves a mixed round to the agent and runs nothing', async () => {
    open([{ name: 'visual', summary: SIGNED }, { name: 'lint', summary: 'error: no-unused-vars' }]);
    expect(await preBriefHostRerun(store, ticketId, deps(0))).toEqual({ kind: 'not-applicable' });
    expect(ran).toHaveLength(0);
    expect(activeFixRound(store, ticketId)).not.toBeNull();
    expect(getTicket(store, ticketId).stageCurrent).toBe('fix');
  });

  it('does nothing for a normal assertion failure', async () => {
    open([{ name: 'unit', summary: 'AssertionError' }]);
    expect(await preBriefHostRerun(store, ticketId, deps(0))).toEqual({ kind: 'not-applicable' });
    expect(ran).toHaveLength(0);
  });

  it('keeps the round open and the stage at fix when the re-run fails, and re-runs only once', async () => {
    open([{ name: 'visual', summary: SIGNED }]);
    const first = await preBriefHostRerun(store, ticketId, deps(1));
    expect(first.kind).toBe('failed');
    expect(activeFixRound(store, ticketId)).not.toBeNull();
    expect(getTicket(store, ticketId).stageCurrent).toBe('fix');
    const second = await preBriefHostRerun(store, ticketId, deps(0));
    expect(second).toEqual({ kind: 'already-used' });
    expect(ran).toHaveLength(1);
    expect(activeFixRound(store, ticketId)).not.toBeNull();
  });

  it('the agent no-change marker then finds the re-run used', async () => {
    open([{ name: 'visual', summary: SIGNED }]);
    await preBriefHostRerun(store, ticketId, deps(1));
    expect((await hostRerunFailedGates(store, ticketId, deps(0))).kind).toBe('already-used');
    expect(ran).toHaveLength(1);
  });

  it('closes at most one round for each ticket and stage: a repeat failure goes to the agent', async () => {
    open([{ name: 'visual', summary: SIGNED }]);
    expect((await preBriefHostRerun(store, ticketId, deps(0))).kind).toBe('passed');
    setStage(store, ticketId, 'uat', { status: 'failed', verdict: 'gates failed', startedAt: AT, endedAt: AT, attempt: 2 });
    setStageCurrent(store, ticketId, 'fix');
    recordGateRun(store, { ticketId, stageKey: 'uat', attempt: 2, runAt: '2026-01-03T00:00:00Z', gates: [{ gateName: 'visual', exitCode: 1, repo: 'web', command: 'npm', args: ['run', 'visual'], summary: SIGNED }] });
    openRecoveryRound(store, { ticketId, sourceStage: 'uat', sourceProcessId: 'gates', triggerKind: 'gate-failure', triggerDetail: 'x', maxRounds: 3, startedAt: AT } as never);
    expect(await preBriefHostRerun(store, ticketId, deps(0))).toEqual({ kind: 'not-applicable' });
    expect(ran).toHaveLength(1);
    expect(activeFixRound(store, ticketId)).not.toBeNull();
  });
});
