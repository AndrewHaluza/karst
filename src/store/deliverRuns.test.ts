import { beforeEach, describe, expect, it } from 'vitest';
import { openStore, type Store } from './db.js';
import { createTicket } from './tickets.js';
import {
  currentDeliverRun, dismissDeliverFailures, finishDeliverRun, listDeliverFailures, listDeliverResults,
  openDeliverRun, recordDeliverGate, setDeliverProgress, stopStaleDeliverRuns, takeOverDeliverRun,
} from './deliverRuns.js';

let store: Store;
let ticketId: number;
beforeEach(() => {
  store = openStore(':memory:');
  ticketId = createTicket(store, { key: 'T-1', title: 't' }).id;
});

const open = (head = 'a'.repeat(40), gates = ['unit', 'docs', 'visual']) =>
  openDeliverRun(store, { ticketId, headSha: head, gates, pid: 7, now: '2026-11-08T10:00:00Z' });

describe('deliver runs', () => {
  it('opens a running run with the planned gate names', () => {
    const id = open();
    expect(currentDeliverRun(store, ticketId)).toMatchObject({ id, state: 'running', headSha: 'a'.repeat(40), gates: ['unit', 'docs', 'visual'], finished: 0, currentGate: null });
  });

  it('tracks the running gate and one result per finished gate', () => {
    const id = open();
    setDeliverProgress(store, id, 'unit');
    recordDeliverGate(store, id, { gateName: 'unit', repo: 'r', exitCode: 0, summary: null, startedAt: 's', endedAt: 'e' });
    const run = currentDeliverRun(store, ticketId)!;
    expect(run.finished).toBe(1);
    expect(listDeliverResults(store, ticketId)).toMatchObject([{ gateName: 'unit', exitCode: 0, headSha: 'a'.repeat(40) }]);
  });

  it('closes an earlier running run as stopped when a new one opens', () => {
    const first = open('1'.repeat(40));
    open('2'.repeat(40));
    expect(store.db.prepare('SELECT state FROM deliver_runs WHERE id = ?').get(first)).toEqual({ state: 'stopped' });
  });

  it('finish does not overwrite a taken-over run', () => {
    const id = open();
    takeOverDeliverRun(store, ticketId, 'T');
    finishDeliverRun(store, id, 'passed', 'T2');
    expect(currentDeliverRun(store, ticketId)?.state).toBe('taken-over');
  });

  it('takeover names the failed and the skipped gates', () => {
    const id = open();
    recordDeliverGate(store, id, { gateName: 'unit', repo: 'r', exitCode: 1, summary: 'boom', startedAt: null, endedAt: null });
    recordDeliverGate(store, id, { gateName: 'docs', repo: 'r', exitCode: 0, summary: null, startedAt: null, endedAt: null });
    expect(takeOverDeliverRun(store, ticketId, 'T')).toEqual({ failed: ['unit'], skipped: ['visual'] });
  });

  it('takeover returns null when no run is in progress', () => {
    expect(takeOverDeliverRun(store, ticketId, 'T')).toBeNull();
  });

  it('keeps a failure after a takeover and a new run on a new head', () => {
    const id = open('a'.repeat(40));
    recordDeliverGate(store, id, { gateName: 'unit', repo: 'r', exitCode: 2, summary: 'boom', startedAt: null, endedAt: null });
    takeOverDeliverRun(store, ticketId, 'T');
    open('b'.repeat(40));
    expect(listDeliverFailures(store, ticketId)).toMatchObject([{ gateName: 'unit', exitCode: 2, headSha: 'a'.repeat(40), summary: 'boom' }]);
  });

  it('a later pass of that gate on a newer head clears the failure', () => {
    const a = open('a'.repeat(40));
    recordDeliverGate(store, a, { gateName: 'unit', repo: 'r', exitCode: 2, summary: 'boom', startedAt: null, endedAt: null });
    const b = open('b'.repeat(40));
    recordDeliverGate(store, b, { gateName: 'unit', repo: 'r', exitCode: 0, summary: null, startedAt: null, endedAt: null });
    expect(listDeliverFailures(store, ticketId)).toEqual([]);
  });

  it('a pass on the SAME head does not clear the failure', () => {
    const a = open('a'.repeat(40));
    recordDeliverGate(store, a, { gateName: 'unit', repo: 'r', exitCode: 2, summary: 'boom', startedAt: null, endedAt: null });
    recordDeliverGate(store, a, { gateName: 'unit', repo: 'r', exitCode: 0, summary: null, startedAt: null, endedAt: null });
    expect(listDeliverFailures(store, ticketId)).toHaveLength(1);
  });

  it('a no-verdict result (null exit) is not a failure', () => {
    const a = open();
    recordDeliverGate(store, a, { gateName: 'unit', repo: 'r', exitCode: null, summary: null, startedAt: null, endedAt: null });
    expect(listDeliverFailures(store, ticketId)).toEqual([]);
  });

  it('dismiss hides the failures of one gate or of all', () => {
    const a = open();
    recordDeliverGate(store, a, { gateName: 'unit', repo: 'r', exitCode: 1, summary: null, startedAt: null, endedAt: null });
    recordDeliverGate(store, a, { gateName: 'docs', repo: 'r', exitCode: 1, summary: null, startedAt: null, endedAt: null });
    dismissDeliverFailures(store, ticketId, 'unit', 'T');
    expect(listDeliverFailures(store, ticketId).map((f) => f.gateName)).toEqual(['docs']);
    dismissDeliverFailures(store, ticketId, null, 'T');
    expect(listDeliverFailures(store, ticketId)).toEqual([]);
  });

  it('stops running runs whose host is gone', () => {
    const id = open();
    expect(stopStaleDeliverRuns(store, () => true, 'T')).toBe(0);
    expect(stopStaleDeliverRuns(store, () => false, 'T')).toBe(1);
    expect(store.db.prepare('SELECT state FROM deliver_runs WHERE id = ?').get(id)).toEqual({ state: 'stopped' });
  });

  it('records the kind of a run: auto by default, after-take-over when asked', () => {
    open();
    expect(currentDeliverRun(store, ticketId)).toMatchObject({ kind: 'auto' });
    openDeliverRun(store, { ticketId, headSha: 'b'.repeat(40), gates: ['visual'], pid: 7, now: '2026-11-08T10:05:00Z', kind: 'after-take-over' });
    expect(currentDeliverRun(store, ticketId)).toMatchObject({ kind: 'after-take-over', state: 'running', gates: ['visual'] });
  });

  it('keeps the failure of an after-take-over run on record until a pass on a newer head', () => {
    const id = openDeliverRun(store, { ticketId, headSha: 'a'.repeat(40), gates: ['visual'], pid: 7, now: 'T', kind: 'after-take-over' });
    recordDeliverGate(store, id, { gateName: 'visual', repo: 'r', exitCode: 1, summary: 'x', startedAt: null, endedAt: null });
    finishDeliverRun(store, id, 'failed', 'T2');
    expect(listDeliverFailures(store, ticketId)).toMatchObject([{ gateName: 'visual', headSha: 'a'.repeat(40) }]);
  });
});
