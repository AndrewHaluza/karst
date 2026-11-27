import { beforeEach, describe, expect, it } from 'vitest';
import { openStore, type Store } from './db.js';
import { createTicket } from './tickets.js';
import { setMergeCheck } from './mergeChecks.js';
import { markConflictRound } from './autopilot.js';
import { openDeliverRun, recordDeliverGate, finishDeliverRun, takeOverDeliverRun } from './deliverRuns.js';
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

  it('marks a base-moved run as a check before push (D541)', () => {
    openDeliverRun(store, { ticketId: id, headSha: 'a'.repeat(40), gates: ['unit', 'docs'], pid: 1, now: 'T', kind: 'base-moved' });
    const running = deliverFactsFor(store, id).running;
    expect(running).toEqual({ n: 1, m: 2, gate: 'unit', baseCheck: true });
    expect(running?.afterTakeOver).toBeUndefined();
  });
  it('does not mark an auto run as a check before push', () => {
    openDeliverRun(store, { ticketId: id, headSha: 'a'.repeat(40), gates: ['unit'], pid: 1, now: 'T' });
    expect(deliverFactsFor(store, id).running?.baseCheck).toBeUndefined();
  });
  it('does not mark an after-take-over run as a check before push', () => {
    openDeliverRun(store, { ticketId: id, headSha: 'a'.repeat(40), gates: ['unit'], pid: 1, now: 'T', kind: 'after-take-over' });
    expect(deliverFactsFor(store, id).running?.baseCheck).toBeUndefined();
  });

  it('an after-take-over run does not arm the round: the head it checks is already on the PR', () => {
    openDeliverRun(store, { ticketId: id, headSha: 'a'.repeat(40), gates: ['visual'], pid: 1, now: 'T', kind: 'after-take-over' });
    expect(deliverFactsFor(store, id).roundActive).toBe(false);
  });
  it('an auto run arms the round', () => {
    openDeliverRun(store, { ticketId: id, headSha: 'a'.repeat(40), gates: ['visual'], pid: 1, now: 'T' });
    expect(deliverFactsFor(store, id).roundActive).toBe(true);
  });
});

describe('deliverFactsFor gates (the per-gate facts the Push row lists)', () => {
  const at = (n: number): string => `2026-01-0${n}T00:00:00.000Z`;
  const gate = (run: number, g: string, exit: number | null, repo = 'r', summary: string | null = 's') =>
    recordDeliverGate(store, run, { gateName: g, repo, exitCode: exit, summary, startedAt: at(1), endedAt: at(2) });

  it('has no gates when no run exists', () => {
    expect(deliverFactsFor(store, id).gates).toBeUndefined();
    expect('gates' in deliverFactsFor(store, id)).toBe(false);
  });

  it('lists one fact per planned gate in plan order: pass, run, pending', () => {
    const run = openDeliverRun(store, { ticketId: id, headSha: 'a'.repeat(40), gates: ['unit', 'docs', 'visual'], pid: 1, now: 'T' });
    gate(run, 'unit', 0);
    expect(deliverFactsFor(store, id).gates).toEqual([
      { name: 'unit', repo: 'r', status: 'pass', startedAt: at(1), endedAt: at(2), exitCode: 0 },
      { name: 'docs', repo: 'r', status: 'run', startedAt: null, endedAt: null, exitCode: null },
      { name: 'visual', repo: 'r', status: 'pending', startedAt: null, endedAt: null, exitCode: null },
    ]);
  });

  it('maps a non-zero exit to fail and keeps the exit code', () => {
    const run = openDeliverRun(store, { ticketId: id, headSha: 'a'.repeat(40), gates: ['unit', 'docs'], pid: 1, now: 'T' });
    gate(run, 'unit', 3);
    expect(deliverFactsFor(store, id).gates?.[0]).toEqual({ name: 'unit', repo: 'r', status: 'fail', startedAt: at(1), endedAt: at(2), exitCode: 3 });
    expect(deliverFactsFor(store, id).gates?.[1]).toMatchObject({ name: 'docs', status: 'run' });
  });

  it('counts a recorded skip (null exit, skipped summary) as pass — the gate was cut, not failed', () => {
    const run = openDeliverRun(store, { ticketId: id, headSha: 'a'.repeat(40), gates: ['visual', 'docs'], pid: 1, now: 'T' });
    gate(run, 'visual', null, 'r', 'skipped: no UI path in the ticket diff');
    expect(deliverFactsFor(store, id).gates?.[0]).toMatchObject({ name: 'visual', status: 'pass', exitCode: null });
  });

  it('leaves a result with no exit and no skip summary pending — nothing proved it passed', () => {
    const run = openDeliverRun(store, { ticketId: id, headSha: 'a'.repeat(40), gates: ['visual'], pid: 1, now: 'T' });
    gate(run, 'visual', null, 'r', 'not run: regenerate failed');
    expect(deliverFactsFor(store, id).gates?.[0]).toMatchObject({ name: 'visual', status: 'pending' });
  });

  it('marks no gate as running once the run ended: a gate with no result stays pending', () => {
    const run = openDeliverRun(store, { ticketId: id, headSha: 'a'.repeat(40), gates: ['unit', 'docs'], pid: 1, now: 'T' });
    gate(run, 'unit', 1);
    finishDeliverRun(store, run, 'failed', 'T2');
    expect(deliverFactsFor(store, id).gates?.map((g) => [g.name, g.status])).toEqual([['unit', 'fail'], ['docs', 'pending']]);
  });

  it('emits one fact per repo result of the same gate, in plan order', () => {
    const run = openDeliverRun(store, { ticketId: id, headSha: 'a'.repeat(40), gates: ['unit', 'unit', 'docs'], pid: 1, now: 'T' });
    gate(run, 'unit', 0, 'api');
    gate(run, 'unit', 1, 'web');
    expect(deliverFactsFor(store, id).gates?.map((g) => [g.name, g.repo, g.status])).toEqual([
      ['unit', 'api', 'pass'],
      ['unit', 'web', 'fail'],
      ['docs', 'web', 'run'],
    ]);
  });

  it('keeps every other field as before while the gates are added', () => {
    const run = openDeliverRun(store, { ticketId: id, headSha: 'a'.repeat(40), gates: ['unit', 'docs'], pid: 1, now: 'T' });
    gate(run, 'unit', 3);
    const f = deliverFactsFor(store, id);
    expect(f).toMatchObject({
      running: { n: 2, m: 2, gate: 'docs' },
      failures: [{ gate: 'unit', repo: 'r', exitCode: 3, headSha: 'a'.repeat(40), summary: 's' }],
      takenOver: null,
      roundActive: true,
      headSha: 'a'.repeat(40),
    });
  });

  it('reads the gates of the current run only, never an older run of the ticket', () => {
    const older = openDeliverRun(store, { ticketId: id, headSha: 'a'.repeat(40), gates: ['unit'], pid: 1, now: 'T1' });
    gate(older, 'unit', 3);
    const newer = openDeliverRun(store, { ticketId: id, headSha: 'b'.repeat(40), gates: ['docs'], pid: 1, now: 'T2' });
    expect(deliverFactsFor(store, id).gates).toEqual([{ name: 'docs', repo: '', status: 'run', startedAt: null, endedAt: null, exitCode: null }]);
    expect(newer).toBeGreaterThan(older);
  });
});
