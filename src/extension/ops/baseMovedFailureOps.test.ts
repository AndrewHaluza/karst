import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { createTicket, getTicket, setStageCurrent } from '../../store/tickets.js';
import { setStage } from '../../store/stages.js';
import { openDeliverRun, recordDeliverGate, finishDeliverRun } from '../../store/deliverRuns.js';
import { transition } from '../../workflow/machine.js';
import { getCiRoundSource } from '../../store/autopilot.js';
import { baseRefOf, failureReason, sendGateFailureToAgent, type BaseMovedFailureOpsDeps } from './baseMovedFailureOps.js';

let store: Store;
let id: number;
const REASON = 'r: gate "unit" fails when merged with origin/develop 1d1930be8 - FAIL a.test.ts';

function seed(opts: { block: boolean; run: 'failed' | 'passed' | null }): void {
  setStage(store, id, 'ship', { status: 'pending', verdict: null, endedAt: null, ...(opts.block ? { blockedKind: 'base-moved-failed' as const, blockedReason: REASON, blockedAt: 'T0' } : {}) });
  if (opts.run) {
    const runId = openDeliverRun(store, { ticketId: id, headSha: 'abc', gates: ['unit'], pid: 1, now: 'T0', kind: 'base-moved' });
    recordDeliverGate(store, runId, { gateName: 'unit', repo: 'r', exitCode: opts.run === 'failed' ? 1 : 0, summary: 'FAIL a.test.ts > case', startedAt: null, endedAt: null });
    finishDeliverRun(store, runId, opts.run, 'T1');
  }
}

function deps(over: Partial<BaseMovedFailureOpsDeps> = {}): BaseMovedFailureOpsDeps & { written: Record<string, string> } {
  const written: Record<string, string> = {};
  return {
    store, ticketId: id, written,
    writeLog: vi.fn((n: string, t: string) => { written[n] = t; return `/art/${n}`; }),
    confirm: vi.fn(async () => true), info: vi.fn(), error: vi.fn(), logError: vi.fn(), debug: vi.fn(), drive: vi.fn(),
    handOff: vi.fn(() => null), afterServerChange: vi.fn(), ...over,
  };
}

beforeEach(() => {
  store = openStore(':memory:');
  id = createTicket(store, { key: 'BM-2', title: 't' }).id;
  for (const from of ['scope', 'impl', 'uat', 'review'] as const) transition(store, id, from, { kind: 'passed' });
});

describe('sendGateFailureToAgent', () => {
  it('writes the gate excerpt, sends the ticket back and tells the agent the four steps', async () => {
    seed({ block: true, run: 'failed' });
    const d = deps();
    await sendGateFailureToAgent(d);
    expect(Object.keys(d.written)).toHaveLength(1);
    expect(Object.values(d.written)[0]).toContain('FAIL a.test.ts > case');
    expect(getTicket(store, id).stageCurrent).toBe('impl');
    const prompt = (d.handOff as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(prompt).toContain('Merge origin/develop into the branch');
    expect(prompt).toContain('Re-record every baseline');
    expect(prompt).toContain('/art/base-moved-failure-');
    expect(d.afterServerChange).toHaveBeenCalledOnce();
  });
  it('carries each failed gate and its excerpt in the reason, and says so when a gate printed nothing', async () => {
    seed({ block: true, run: 'failed' });
    const runId = openDeliverRun(store, { ticketId: id, headSha: 'abd', gates: ['unit', 'lint'], pid: 1, now: 'T2', kind: 'base-moved' });
    recordDeliverGate(store, runId, { gateName: 'lint', repo: 'r', exitCode: 2, summary: null, startedAt: null, endedAt: null });
    finishDeliverRun(store, runId, 'failed', 'T3');
    const d = deps();
    await sendGateFailureToAgent(d);
    const prompt = (d.handOff as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(prompt).toContain('- r: gate "lint" exit 2: (the gate printed no output; run it on the merged tree to see the failure)');
    expect(Object.values(d.written)[0]).toContain('the gate printed no output');
  });
  it.each([
    ['no block', { block: false, run: 'failed' as const }],
    ['a passed run', { block: true, run: 'passed' as const }],
    ['no run', { block: true, run: null }],
  ])('moves nothing for %s', async (_n, o) => {
    seed(o);
    const d = deps();
    await sendGateFailureToAgent(d);
    expect(d.writeLog).not.toHaveBeenCalled();
    expect(d.confirm).not.toHaveBeenCalled();
    expect(getTicket(store, id).stageCurrent).toBe('ship');
    expect(d.afterServerChange).toHaveBeenCalledOnce();
  });
  it('moves nothing when the user declines', async () => {
    seed({ block: true, run: 'failed' });
    const d = deps({ confirm: vi.fn(async () => false) });
    await sendGateFailureToAgent(d);
    expect(d.writeLog).not.toHaveBeenCalled();
    expect(getTicket(store, id).stageCurrent).toBe('ship');
  });
});

describe('baseRefOf', () => {
  it('reads the base from the reason', () => {
    expect(baseRefOf(REASON)).toBe('develop');
    expect(baseRefOf('nothing')).toBeNull();
  });
});

describe('sendGateFailureToAgent on a graph ticket (T1158)', () => {
  it('enters a fix round at ship, names three steps and no impl marker, and hands nothing to an impl session', async () => {
    seed({ block: true, run: 'failed' });
    const d = deps({ implRunsGraph: () => true });
    await sendGateFailureToAgent(d);
    expect(getTicket(store, id).stageCurrent).toBe('fix');
    const ship = getTicket(store, id).stages.find((s) => s.stageKey === 'ship');
    expect(ship?.status).toBe('failed');
    expect(ship?.artifactPath).toContain('/art/base-moved-failure-');
    expect(ship?.verdict).toContain('3. Re-record every baseline');
    expect(ship?.verdict?.split('\n').at(-1)).toBe('3. Re-record every baseline that the merge changed.');
    expect(d.confirm).toHaveBeenCalledWith(
      'This writes the failed gate excerpts and moves the ticket to Fix; UAT and Review will run again. The pull requests stay open.',
    );
    expect(d.handOff).not.toHaveBeenCalled();
    expect(d.drive).toHaveBeenCalledOnce();
    expect(d.info).toHaveBeenCalledWith('Gate failure sent to a fix session. The ticket moved to Fix from Ship.');
  });
  it('a ticket whose impl runs no graph keeps the four steps and the send-back', async () => {
    seed({ block: true, run: 'failed' });
    const d = deps({ implRunsGraph: () => false });
    await sendGateFailureToAgent(d);
    expect(getTicket(store, id).stageCurrent).toBe('impl');
    expect(d.confirm).toHaveBeenCalledWith(
      'This writes the failed gate excerpts and moves the ticket back to Implement; UAT and Review will run again. The pull requests stay open.',
    );
    expect((d.handOff as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toContain('4. Call the karst MCP tool `stage` with { stage: "impl" }.');
  });
});

describe('failureReason route (T1158)', () => {
  const f = { run: {} as never, reason: 'r: gate "lint" fails when merged with origin/develop abc - x', failed: [] };
  it('keeps the impl marker step by default', () => {
    expect(failureReason(f, '/p').split('\n').at(-1)).toBe('4. Call the karst MCP tool `stage` with { stage: "impl" }.');
  });
  it('drops the impl marker step for a fix round', () => {
    expect(failureReason(f, '/p', false).split('\n').at(-1)).toBe('3. Re-record every baseline that the merge changed.');
  });
});

describe('sendGateFailureToAgent manual re-ship mark (T1212)', () => {
  it('marks the round manual on both routes, and not without the flag', async () => {
    seed({ block: true, run: 'failed' });
    await sendGateFailureToAgent(deps());
    expect(getCiRoundSource(store, id)).toBeNull();
    setStageCurrent(store, id, 'ship');
    setStage(store, id, 'ship', { status: 'pending', verdict: null, endedAt: null, blockedKind: 'base-moved-failed' as const, blockedReason: REASON, blockedAt: 'T0' });
    await sendGateFailureToAgent(deps({ markManualReship: true, implRunsGraph: () => true }));
    expect(getCiRoundSource(store, id)).toBe('manual');
  });
  it('sets the mark before the driver runs, on both routes', async () => {
    const seen: Array<string | null> = [];
    seed({ block: true, run: 'failed' });
    await sendGateFailureToAgent(deps({ markManualReship: true, drive: vi.fn(() => { seen.push(getCiRoundSource(store, id)); }) }));
    setStageCurrent(store, id, 'ship');
    setStage(store, id, 'ship', { status: 'pending', verdict: null, endedAt: null, blockedKind: 'base-moved-failed' as const, blockedReason: REASON, blockedAt: 'T0' });
    await sendGateFailureToAgent(deps({ markManualReship: true, implRunsGraph: () => true, drive: vi.fn(() => { seen.push(getCiRoundSource(store, id)); }) }));
    expect(seen).toEqual(['manual', 'manual']);
  });
  it('marks a send-back to Implement and no mark after a declined confirm', async () => {
    seed({ block: true, run: 'failed' });
    await sendGateFailureToAgent(deps({ markManualReship: true, confirm: vi.fn(async () => false) }));
    expect(getCiRoundSource(store, id)).toBeNull();
    await sendGateFailureToAgent(deps({ markManualReship: true }));
    expect(getCiRoundSource(store, id)).toBe('manual');
  });
});
