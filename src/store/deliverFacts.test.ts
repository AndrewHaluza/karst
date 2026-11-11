import { beforeEach, describe, expect, it } from 'vitest';
import { openStore, type Store } from './db.js';
import { createTicket } from './tickets.js';
import { setMergeCheck } from './mergeChecks.js';
import { markConflictRound } from './autopilot.js';
import { openDeliverRun, recordDeliverGate, takeOverDeliverRun } from './deliverRuns.js';
import { deliverFactsFor } from './deliverFacts.js';

let store: Store;
let id: number;
beforeEach(() => { store = openStore(':memory:'); id = createTicket(store, { key: 'T-1', title: 't' }).id; });
const rec = (run: number, gate: string, exit: number) => recordDeliverGate(store, run, { gateName: gate, repo: 'r', exitCode: exit, summary: 's', startedAt: null, endedAt: null });

describe('deliverFactsFor', () => {
  it('is empty with no run', () => {
    expect(deliverFactsFor(store, id)).toEqual({ running: null, failures: [], takenOver: null, roundActive: false, headSha: null });
  });
  it('reports gate n/m of a running run', () => {
    const run = openDeliverRun(store, { ticketId: id, headSha: 'a'.repeat(40), gates: ['unit', 'docs', 'visual'], pid: 1, now: 'T' });
    rec(run, 'unit', 0);
    expect(deliverFactsFor(store, id)).toMatchObject({ running: { n: 2, m: 3, gate: 'docs' }, roundActive: true, headSha: 'a'.repeat(40) });
  });
  it('reports the takeover and keeps the failure', () => {
    const run = openDeliverRun(store, { ticketId: id, headSha: 'a'.repeat(40), gates: ['unit', 'docs'], pid: 1, now: 'T' });
    rec(run, 'unit', 3);
    takeOverDeliverRun(store, id, 'T');
    const f = deliverFactsFor(store, id);
    expect(f.takenOver).toEqual({ failed: ['unit'], skipped: ['docs'] });
    expect(f.running).toBeNull();
    expect(f.failures).toMatchObject([{ gate: 'unit', exitCode: 3 }]);
  });
  it('takes the current head from the merge probe, not the last run', () => {
    openDeliverRun(store, { ticketId: id, headSha: 'a'.repeat(40), gates: ['unit'], pid: 1, now: 'T' });
    setMergeCheck(store, { ticketId: id, repo: 'r', state: 'clean', files: [], reason: null, headSha: 'b'.repeat(40), baseSha: null, baseRef: null, checkedAt: 'T2' });
    expect(deliverFactsFor(store, id).headSha).toBe('b'.repeat(40));
  });
  it('is round-active while an Autopilot conflict round is armed, before any gate runs', () => {
    markConflictRound(store, id, 1);
    expect(deliverFactsFor(store, id)).toMatchObject({ running: null, roundActive: true });
  });
  it('names a skipped gate that repeats in another repo once per missing result', () => {
    const run = openDeliverRun(store, { ticketId: id, headSha: 'a'.repeat(40), gates: ['unit', 'unit', 'docs'], pid: 1, now: 'T' });
    rec(run, 'unit', 0);
    takeOverDeliverRun(store, id, 'T');
    expect(deliverFactsFor(store, id).takenOver).toEqual({ failed: [], skipped: ['unit', 'docs'] });
  });

  it('marks the running run as after-take-over so the wording does not promise a push', () => {
    openDeliverRun(store, { ticketId: id, headSha: 'a'.repeat(40), gates: ['integration', 'visual'], pid: 1, now: 'T', kind: 'after-take-over' });
    expect(deliverFactsFor(store, id).running).toEqual({ n: 1, m: 2, gate: 'integration', afterTakeOver: true });
  });
  it('does not mark an auto run as after-take-over', () => {
    openDeliverRun(store, { ticketId: id, headSha: 'a'.repeat(40), gates: ['unit'], pid: 1, now: 'T' });
    expect(deliverFactsFor(store, id).running).toEqual({ n: 1, m: 1, gate: 'unit' });
  });
});
