import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { createTicket } from '../../store/tickets.js';
import { setStage } from '../../store/stages.js';
import { transition } from '../../workflow/machine.js';
import { stageBlock } from '../../store/stageBlocks.js';
import { openDeliverRun, recordDeliverGate, finishDeliverRun } from '../../store/deliverRuns.js';
import { getAutopilotBudget, getAutopilotTicket, getCiRoundAt, getCiRoundHeadSha } from '../../store/autopilot.js';
import type { AutopilotConfig } from '../../manifest/autopilot.js';
import { autopilotTick, NO_CHANGE_BASE_MOVED_REASON, type AutopilotDeps, type FixOutcome } from './autopilotOps.js';

const REASON = 'r: gate "unit" fails when merged with origin/develop 1d1930be8 - FAIL a.test.ts';
const CFG: AutopilotConfig = { enabled: true, ci: { policy: 'auto', maxAttempts: 3, checks: ['build'] }, conflicts: { policy: 'auto', maxRounds: 2 } };
let store: Store;
let id: number;

/** Ship parks with `base-moved-failed` before its push; the newest base-moved run failed on `head`. */
function parkFailed(head: string): void {
  setStage(store, id, 'ship', { status: 'pending', verdict: null, endedAt: null, blockedKind: 'base-moved-failed', blockedReason: REASON, blockedAt: 'T0' });
  const runId = openDeliverRun(store, { ticketId: id, headSha: head, gates: ['unit'], pid: 1, now: 'T0', kind: 'base-moved' });
  recordDeliverGate(store, runId, { gateName: 'unit', repo: 'r', exitCode: 1, summary: 'FAIL a.test.ts', startedAt: null, endedAt: null });
  finishDeliverRun(store, runId, 'failed', 'T1');
}

function rig(outcome: FixOutcome = { kind: 'sent' }, over: Partial<AutopilotDeps> = {}) {
  const notes: Array<[string, string]> = [];
  const sendGate = vi.fn(async () => outcome);
  const sendCi = vi.fn(async () => outcome);
  const deps: AutopilotDeps = {
    store, ticketId: id, key: 'BM-1', config: () => CFG, controls: () => true, sessionRunning: () => false, concurrencyFull: () => false,
    placement: async () => 'host', isGraphTicket: () => false, sendCiFailure: sendCi, sendGateFailure: sendGate, sendConflict: async () => outcome,
    conflictRoundActive: () => false, conflictRoundStalled: () => false, dropConflictRound: () => {},
    note: (t, b) => void notes.push([t, b]), debug: vi.fn(), ...over,
  };
  return { deps, notes, sendGate, sendCi };
}

beforeEach(() => {
  store = openStore(':memory:');
  id = createTicket(store, { key: 'BM-1', title: 't' }).id;
  for (const from of ['scope', 'impl', 'uat', 'review'] as const) transition(store, id, from, { kind: 'passed' });
});

describe('autopilot on a base-moved-failed block (@arch:AP-00)', () => {
  it('starts one CI round through the CI budget, marks it and records the head the failed run tested', async () => {
    parkFailed('head1');
    const r = rig();
    const result = await autopilotTick(r.deps);
    expect(result).toEqual({ kind: 'armed', problem: 'ci', used: 1, max: 3 });
    expect(r.sendGate).toHaveBeenCalledOnce();
    expect(r.sendCi).not.toHaveBeenCalled();
    expect(getAutopilotBudget(store, id, 'r', 'ci').attempts).toBe(1);
    expect(getCiRoundAt(store, id)).not.toBeNull();
    expect(getCiRoundHeadSha(store, id, 'r')).toBe('head1');
  });

  it('parks with "base-moved round made no change" on a second failure on the same head, and keeps the block', async () => {
    parkFailed('head1');
    await autopilotTick(rig().deps);
    // The round came back: ship parked again with a new failed run on the SAME head.
    parkFailed('head1');
    const r = rig();
    const result = await autopilotTick(r.deps);
    expect(result).toEqual({ kind: 'parked', reason: NO_CHANGE_BASE_MOVED_REASON });
    expect(r.sendGate).not.toHaveBeenCalled();
    expect(stageBlock(store, id, 'ship')).toMatchObject({ kind: 'base-moved-failed', reason: REASON });
    expect(getAutopilotTicket(store, id).stoppedReason).toBe(NO_CHANGE_BASE_MOVED_REASON);
    expect(getAutopilotBudget(store, id, 'r', 'ci').attempts).toBe(1);
    // The park is quiet afterwards.
    expect((await autopilotTick(rig().deps)).kind).toBe('idle');
  });

  it('starts a second round when the head changed', async () => {
    parkFailed('head1');
    await autopilotTick(rig().deps);
    parkFailed('head2');
    expect((await autopilotTick(rig().deps)).kind).toBe('armed');
    expect(getAutopilotBudget(store, id, 'r', 'ci').attempts).toBe(2);
  });

  it('parks when the CI budget is spent', async () => {
    for (let i = 1; i <= 3; i += 1) { parkFailed(`h${i}`); await autopilotTick(rig().deps); }
    parkFailed('h4');
    const result = await autopilotTick(rig().deps);
    expect(result).toMatchObject({ kind: 'parked', reason: 'auto-fix stopped: ci 3/3' });
    expect(stageBlock(store, id, 'ship')?.kind).toBe('base-moved-failed');
  });

  it('starts no round when the ci policy is ask, a session runs, another window controls, or the seam is absent', async () => {
    parkFailed('head1');
    expect((await autopilotTick(rig({ kind: 'sent' }, { config: () => ({ ...CFG, ci: { ...CFG.ci, policy: 'ask' } }) }).deps)).kind).toBe('ask');
    expect((await autopilotTick(rig({ kind: 'sent' }, { sessionRunning: () => true }).deps)).kind).toBe('busy');
    expect((await autopilotTick(rig({ kind: 'sent' }, { controls: () => false }).deps)).kind).toBe('not-controller');
    expect((await autopilotTick(rig({ kind: 'sent' }, { sendGateFailure: undefined }).deps)).kind).toBe('idle');
    expect(getAutopilotBudget(store, id, 'r', 'ci').attempts).toBe(0);
  });

  it('gives the attempt back and keeps the block when the action fails', async () => {
    parkFailed('head1');
    const result = await autopilotTick(rig({ kind: 'failed', reason: 'boom' }).deps);
    expect(result.kind).toBe('parked');
    expect(getAutopilotBudget(store, id, 'r', 'ci').attempts).toBe(0);
    expect(stageBlock(store, id, 'ship')?.kind).toBe('base-moved-failed');
  });

  it('does nothing when the newest base-moved run did not fail', async () => {
    setStage(store, id, 'ship', { status: 'pending', verdict: null, endedAt: null, blockedKind: 'base-moved-failed', blockedReason: REASON, blockedAt: 'T0' });
    const r = rig();
    expect((await autopilotTick(r.deps)).kind).toBe('nothing');
    expect(r.sendGate).not.toHaveBeenCalled();
  });

  it('starts no round when no gate exited non-zero (a refused gate), and takes no budget', async () => {
    setStage(store, id, 'ship', { status: 'pending', verdict: null, endedAt: null, blockedKind: 'base-moved-failed', blockedReason: 'fails when merged with origin/develop abc; CI tests this merge - r: gate "unit" could not run', blockedAt: 'T0' });
    const runId = openDeliverRun(store, { ticketId: id, headSha: 'head1', gates: ['unit'], pid: 1, now: 'T0', kind: 'base-moved' });
    recordDeliverGate(store, runId, { gateName: 'unit', repo: 'r', exitCode: null, summary: null, startedAt: null, endedAt: null });
    finishDeliverRun(store, runId, 'failed', 'T1');
    const r = rig();
    expect((await autopilotTick(r.deps)).kind).toBe('nothing');
    expect(r.sendGate).not.toHaveBeenCalled();
    expect(getAutopilotBudget(store, id, 'r', 'ci').attempts).toBe(0);
  });
});
