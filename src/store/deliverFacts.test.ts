import { beforeEach, describe, expect, it } from 'vitest';
import { openStore, type Store } from './db.js';
import { createTicket } from './tickets.js';
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
});
