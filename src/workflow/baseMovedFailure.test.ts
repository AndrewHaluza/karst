import { describe, it, expect, beforeEach } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { createTicket } from '../store/tickets.js';
import { setStage } from '../store/stages.js';
import { openDeliverRun, recordDeliverGate, finishDeliverRun } from '../store/deliverRuns.js';
import { transition } from './machine.js';
import { baseMovedFailureState, latestBaseMovedFailedGates } from './baseMovedFailure.js';

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
  it('ignores a newer auto run and a gate that did not exit non-zero', () => {
    const bm = run('base-moved', 'failed');
    run('auto', 'failed');
    expect(latestBaseMovedFailedGates(store, id, 'r').map((g) => g.runId)).toEqual([bm]);
    store.db.prepare('UPDATE deliver_gate_results SET exit_code = NULL WHERE run_id = ?').run(bm);
    expect(latestBaseMovedFailedGates(store, id, 'r')).toEqual([]);
  });
});
