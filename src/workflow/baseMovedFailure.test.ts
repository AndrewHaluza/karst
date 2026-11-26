import { describe, it, expect, beforeEach } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { createTicket, setStageCurrent } from '../store/tickets.js';
import { setStage } from '../store/stages.js';
import { openDeliverRun, recordDeliverGate, finishDeliverRun } from '../store/deliverRuns.js';
import { transition } from './machine.js';
import { baseMovedFailureState, deliverRunFailureState, latestBaseMovedFailedGates, shipGateFailureState } from './baseMovedFailure.js';

let store: Store;
let id: number;
const REASON = 'r: gate "unit" fails when merged with origin/develop 1d1930be8 - FAIL a.test.ts';

function park(kind: string | null = 'base-moved-failed'): void {
  setStage(store, id, 'ship', { status: 'pending', verdict: null, endedAt: null, blockedKind: kind as never, blockedReason: kind ? REASON : null, blockedAt: kind ? 'T0' : null });
}

function run(kindName: 'base-moved' | 'auto', state: 'failed' | 'passed', exit = 1): number {
  const runId = openDeliverRun(store, { ticketId: id, headSha: 'abc', gates: ['unit'], pid: 1, now: 'T0', kind: kindName });
  recordDeliverGate(store, runId, { gateName: 'unit', repo: 'r', exitCode: exit, summary: 'FAIL a.test.ts', startedAt: null, endedAt: null });
  finishDeliverRun(store, runId, state, 'T1');
  return runId;
}

beforeEach(() => {
  store = openStore(':memory:');
  id = createTicket(store, { key: 'BM-1', title: 't' }).id;
  for (const from of ['scope', 'impl', 'uat', 'review'] as const) transition(store, id, from, { kind: 'passed' });
  setStageCurrent(store, id, 'ship');
});

describe('baseMovedFailureState', () => {
  it('is available with the failed gates when the block is base-moved-failed and the newest base-moved run failed', () => {
    park();
    const runId = run('base-moved', 'failed');
    const s = baseMovedFailureState(store, id);
    expect(s).toMatchObject({ available: true, reason: REASON, run: { id: runId } });
    if (s.available) expect(s.failed.map((g) => g.gateName)).toEqual(['unit']);
  });
  it('is not offered without the block', () => {
    park(null);
    run('base-moved', 'failed');
    expect(baseMovedFailureState(store, id)).toEqual({ available: false, reason: 'no-block' });
  });
  it('is not offered when the block is another kind', () => {
    park('awaiting-merge');
    run('base-moved', 'failed');
    expect(baseMovedFailureState(store, id)).toEqual({ available: false, reason: 'no-block' });
  });
  it('is not offered when the newest base-moved run passed or none ran', () => {
    park();
    expect(baseMovedFailureState(store, id)).toEqual({ available: false, reason: 'no-failed-run' });
    run('base-moved', 'failed');
    run('base-moved', 'passed', 0);
    expect(baseMovedFailureState(store, id)).toEqual({ available: false, reason: 'no-failed-run' });
  });
  it('ignores a failed run of another kind', () => {
    park();
    run('auto', 'failed');
    expect(baseMovedFailureState(store, id)).toEqual({ available: false, reason: 'no-failed-run' });
  });
  it('is not offered while a PR has merged', () => {
    park();
    run('base-moved', 'failed');
    store.db.prepare('INSERT INTO prs (ticket_id, repo, number, url, status) VALUES (?, ?, ?, ?, ?)').run(id, 'r', 5, 'https://github.com/o/r/pull/5', 'merged');
    expect(baseMovedFailureState(store, id)).toEqual({ available: false, reason: 'landed' });
  });
});

describe('shipGateFailureState (T1381)', () => {
  it('reads the newest run of kind auto or base-moved, ignoring another kind', () => {
    park();
    // An auto-deliver run that refused a resolved merge is the block's run.
    const auto = run('auto', 'failed');
    expect(shipGateFailureState(store, id)).toMatchObject({ available: true, run: { id: auto } });
    // The newest of the two kinds wins.
    const baseMoved = run('base-moved', 'failed');
    expect(shipGateFailureState(store, id)).toMatchObject({ available: true, run: { id: baseMoved } });
    // A run of another kind is never the block's run.
    openDeliverRun(store, { ticketId: id, headSha: 'abc', gates: ['unit'], pid: 1, now: 'T0', kind: 'after-take-over' });
    expect(shipGateFailureState(store, id)).toMatchObject({ available: true, run: { id: baseMoved } });
  });
});

describe('deliverRunFailureState (T1381)', () => {
  const BASE = '1d1930be8f'.padEnd(40, '0');

  function failed(kindName: 'auto' | 'base-moved', exit: number | null = 1, state: 'failed' | 'passed' = 'failed'): number {
    const runId = openDeliverRun(store, { ticketId: id, headSha: 'head1', gates: ['unit'], pid: 1, now: 'T0', kind: kindName });
    recordDeliverGate(store, runId, { gateName: 'unit', repo: 'r', exitCode: exit, summary: 'FAIL a.test.ts', startedAt: null, endedAt: null });
    finishDeliverRun(store, runId, state, 'T1');
    return runId;
  }

  it('reads a failed auto run and formats the reason with the base ref', () => {
    const runId = failed('auto');
    const s = deliverRunFailureState(store, id, runId, 'develop', BASE);
    expect(s).toMatchObject({ available: true, run: { id: runId }, failed: [{ gateName: 'unit', repo: 'r' }] });
    if (s.available) {
      expect(s.reason).toBe(`r: gate "unit" fails when merged with origin/develop ${BASE.slice(0, 9)} - FAIL a.test.ts`);
      expect(/merged with origin\/develop/.test(s.reason)).toBe(true);
    }
  });

  it('reads a failed base-moved run', () => {
    const runId = failed('base-moved');
    expect(deliverRunFailureState(store, id, runId, 'develop', BASE)).toMatchObject({ available: true, run: { id: runId } });
  });

  it('is not available for a run that is still running or passed', () => {
    const running = openDeliverRun(store, { ticketId: id, headSha: 'head1', gates: ['unit'], pid: 1, now: 'T0', kind: 'auto' });
    expect(deliverRunFailureState(store, id, running, 'develop', BASE)).toEqual({ available: false, reason: 'no-failed-run' });
    const passed = failed('auto', 0, 'passed');
    expect(deliverRunFailureState(store, id, passed, 'develop', BASE)).toEqual({ available: false, reason: 'no-failed-run' });
  });

  it('is not available for an unknown run id or another ticket run', () => {
    expect(deliverRunFailureState(store, id, 9999, 'develop', BASE)).toEqual({ available: false, reason: 'no-failed-run' });
    const runId = failed('auto');
    const other = createTicket(store, { key: 'BM-2', title: 't' }).id;
    setStageCurrent(store, other, 'ship');
    expect(deliverRunFailureState(store, other, runId, 'develop', BASE)).toEqual({ available: false, reason: 'no-failed-run' });
  });

  it('is not available without a readable base ref or base sha', () => {
    const runId = failed('auto');
    expect(deliverRunFailureState(store, id, runId, null, BASE)).toEqual({ available: false, reason: 'no-failed-run' });
    expect(deliverRunFailureState(store, id, runId, '  ', BASE)).toEqual({ available: false, reason: 'no-failed-run' });
    expect(deliverRunFailureState(store, id, runId, 'develop', null)).toEqual({ available: false, reason: 'no-failed-run' });
    expect(deliverRunFailureState(store, id, runId, 'develop', ' ')).toEqual({ available: false, reason: 'no-failed-run' });
  });

  it('is not available outside the ship stage or once a PR has landed', () => {
    const runId = failed('auto');
    setStageCurrent(store, id, 'review');
    expect(deliverRunFailureState(store, id, runId, 'develop', BASE)).toEqual({ available: false, reason: 'stage' });
    setStageCurrent(store, id, 'ship');
    store.db.prepare('INSERT INTO prs (ticket_id, repo, number, url, status) VALUES (?, ?, ?, ?, ?)').run(id, 'r', 5, 'https://github.com/o/r/pull/5', 'merged');
    expect(deliverRunFailureState(store, id, runId, 'develop', BASE)).toEqual({ available: false, reason: 'landed' });
  });

  it('is available with no failed gate rows, and says a ship gate failed', () => {
    const runId = openDeliverRun(store, { ticketId: id, headSha: 'head1', gates: ['unit'], pid: 1, now: 'T0', kind: 'auto' });
    recordDeliverGate(store, runId, { gateName: 'unit', repo: 'r', exitCode: null, summary: null, startedAt: null, endedAt: null });
    finishDeliverRun(store, runId, 'failed', 'T1');
    const s = deliverRunFailureState(store, id, runId, 'develop', BASE);
    expect(s).toMatchObject({ available: true, failed: [] });
    if (s.available) expect(s.reason).toBe(`fails when merged with origin/develop ${BASE.slice(0, 9)}; CI tests this merge - a ship gate failed`);
  });
});

describe('latestBaseMovedFailedGates (T1169)', () => {
  it('returns the failed gates of the newest base-moved run for the repo', () => {
    run('base-moved', 'failed');
    const newest = run('base-moved', 'failed');
    expect(latestBaseMovedFailedGates(store, id, 'r').map((g) => g.runId)).toEqual([newest]);
  });
  it('is empty for another repo, a passed run, an auto run, a skipped gate and no run', () => {
    expect(latestBaseMovedFailedGates(store, id, 'r')).toEqual([]);
    run('base-moved', 'failed');
    expect(latestBaseMovedFailedGates(store, id, 'other')).toEqual([]);
    run('base-moved', 'passed', 0);
    expect(latestBaseMovedFailedGates(store, id, 'r')).toEqual([]);
  });
  it('ignores a newer auto run, and a gate that did not exit non-zero is not a failure', () => {
    const bm = run('base-moved', 'failed');
    run('auto', 'failed');
    // The ship's base-moved remedy names the base-moved run, never an unrelated auto-deliver run (@arch:AP-14).
    expect(latestBaseMovedFailedGates(store, id, 'r').map((g) => g.runId)).toEqual([bm]);
    store.db.prepare('UPDATE deliver_gate_results SET exit_code = NULL WHERE run_id = ?').run(bm);
    expect(latestBaseMovedFailedGates(store, id, 'r')).toEqual([]);
  });
});
