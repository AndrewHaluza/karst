import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { createTicket } from '../store/tickets.js';
import { setStage } from '../store/stages.js';
import { openImplementationRun, completeImplementationRun, interruptImplementationRun } from '../store/implementationRuns.js';
import { listPhaseMarks, recordPhaseMark } from '../store/phaseMarks.js';
import { recordHostPhaseFromRevision, hostPhaseOnRevision, type ApproachPhase } from './phaseEvidence.js';

/**
 * Rule B (@arch:RESULTS, @arch:APP-09): the FIRST captured revision of a kind a
 * phase declares is the evidence that the phase happened, so the host marks the
 * phase AFTER it. Every guard here exists to keep that an observation: no run,
 * a stale run, a deletion or a kind no phase declares writes nothing.
 */
describe('recordHostPhaseFromRevision', () => {
  let store: Store;
  let ticketId: number;
  const AT = '2026-08-01T12:00:00.000Z';
  const phases: ApproachPhase[] = [
    { name: 'plan', outputKind: 'plan' },
    { name: 'implement' },
  ];

  const event = (kind: string, extra: { deleted?: true } = {}) => ({
    ticketId, kind, sha: 'sha', path: 'app/docs/plans/p.md', ...extra,
  });

  const deps = (overrides: { phasesOf?: (id: number) => readonly ApproachPhase[]; debug?: (m: string) => void } = {}) => ({
    store,
    phasesOf: overrides.phasesOf ?? (() => phases),
    now: () => AT,
    debug: overrides.debug ?? (() => {}),
  });

  beforeEach(() => {
    store = openStore(':memory:');
    const t = createTicket(store, { key: 'A', title: 'a' });
    ticketId = t.id;
    setStage(store, t.id, 'impl', { status: 'running', attempt: 0 });
    store.db.prepare("UPDATE tickets SET stage_current = 'impl' WHERE id = ?").run(t.id);
  });
  afterEach(() => store.close());

  const openRun = (attempt = 0) =>
    openImplementationRun(store, {
      ticketId, attempt, provider: 'claude', model: 'opus', startedAt: '2026-08-01T11:00:00.000Z',
    });

  it('writes one host mark for the phase after the one whose output arrived', () => {
    const run = openRun(2);
    expect(recordHostPhaseFromRevision(deps(), event('plan'))).toBe(true);

    expect(listPhaseMarks(store, ticketId)).toEqual([
      expect.objectContaining({
        stageKey: 'impl',
        attempt: 2,
        phaseName: 'implement',
        source: 'host',
        implementationRunId: run.id,
        markedAt: AT,
      }),
    ]);
  });

  it('writes nothing on a second capture of the same kind', () => {
    openRun();
    expect(recordHostPhaseFromRevision(deps(), event('plan'))).toBe(true);
    expect(recordHostPhaseFromRevision(deps(), event('plan'))).toBe(false);
    expect(listPhaseMarks(store, ticketId)).toHaveLength(1);
  });

  it('writes nothing when the agent marked that phase in the same attempt', () => {
    openRun();
    recordPhaseMark(store, {
      ticketId, stageKey: 'impl', attempt: 0, phaseName: 'implement',
      markedAt: '2026-08-01T11:30:00.000Z', source: 'agent',
    });

    expect(recordHostPhaseFromRevision(deps(), event('plan'))).toBe(false);
    expect(listPhaseMarks(store, ticketId).map((m) => m.source)).toEqual(['agent']);
  });

  it('writes the host mark when the agent mark is in an older attempt', () => {
    openRun();
    recordPhaseMark(store, {
      ticketId, stageKey: 'impl', attempt: 1, phaseName: 'implement',
      markedAt: '2026-08-01T11:30:00.000Z', source: 'agent',
    });

    expect(recordHostPhaseFromRevision(deps(), event('plan'))).toBe(true);
    expect(listPhaseMarks(store, ticketId)).toHaveLength(2);
  });

  it('writes nothing for a kind no phase declares', () => {
    openRun();
    expect(recordHostPhaseFromRevision(deps(), event('script'))).toBe(false);
    expect(listPhaseMarks(store, ticketId)).toEqual([]);
  });

  it('writes nothing for a deletion', () => {
    openRun();
    expect(recordHostPhaseFromRevision(deps(), event('plan', { deleted: true }))).toBe(false);
    expect(listPhaseMarks(store, ticketId)).toEqual([]);
  });

  it('writes nothing when the evidence phase is the last phase', () => {
    openRun();
    const kindLast: ApproachPhase[] = [{ name: 'plan' }, { name: 'implement', outputKind: 'plan' }];
    expect(recordHostPhaseFromRevision(deps({ phasesOf: () => kindLast }), event('plan'))).toBe(false);
    expect(listPhaseMarks(store, ticketId)).toEqual([]);
  });

  it('writes nothing with no run', () => {
    expect(recordHostPhaseFromRevision(deps(), event('plan'))).toBe(false);
    expect(listPhaseMarks(store, ticketId)).toEqual([]);
  });

  it('writes nothing for a passed or interrupted run', () => {
    openRun();
    completeImplementationRun(store, ticketId, '2026-08-01T11:30:00.000Z');
    expect(recordHostPhaseFromRevision(deps(), event('plan'))).toBe(false);

    const other = createTicket(store, { key: 'B', title: 'b' });
    ticketId = other.id;
    setStage(store, other.id, 'impl', { status: 'running', attempt: 0 });
    store.db.prepare("UPDATE tickets SET stage_current = 'impl' WHERE id = ?").run(other.id);
    openRun();
    interruptImplementationRun(store, other.id, '2026-08-01T11:30:00.000Z');
    expect(recordHostPhaseFromRevision(deps(), event('plan'))).toBe(false);
    expect(listPhaseMarks(store, other.id)).toEqual([]);
  });

  it('writes nothing for a ticket in uat whose running run is stale', () => {
    openRun();
    store.db.prepare("UPDATE tickets SET stage_current = 'uat' WHERE id = ?").run(ticketId);

    expect(recordHostPhaseFromRevision(deps(), event('plan'))).toBe(false);
    expect(listPhaseMarks(store, ticketId)).toEqual([]);
  });

  it('lets the first phase that declares the kind decide', () => {
    openRun();
    const twice: ApproachPhase[] = [
      { name: 'research', outputKind: 'plan' },
      { name: 'plan', outputKind: 'plan' },
      { name: 'implement' },
    ];
    expect(recordHostPhaseFromRevision(deps({ phasesOf: () => twice }), event('plan'))).toBe(true);
    expect(listPhaseMarks(store, ticketId)[0]!.phaseName).toBe('plan');
  });

  it('never throws away the caller’s listener: a throwing phase reader still forwards and debugs', () => {
    openRun();
    const lines: string[] = [];
    const forwarded: string[] = [];
    const listener = hostPhaseOnRevision(
      deps({ phasesOf: () => { throw new Error('unreadable'); }, debug: (m) => lines.push(m) }),
      (e) => forwarded.push(e.kind),
    );

    expect(() => listener(event('plan'))).not.toThrow();
    expect(forwarded).toEqual(['plan']);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('[artifacts]');
  });

  it('runs rule B and the forwarded listener for one event, rule B first', () => {
    openRun();
    const forwarded: number[] = [];
    const listener = hostPhaseOnRevision(deps(), () => forwarded.push(listPhaseMarks(store, ticketId).length));

    listener(event('plan'));

    // The forwarded listener already sees the host mark: rule B ran first.
    expect(forwarded).toEqual([1]);
    expect(listPhaseMarks(store, ticketId)[0]!.phaseName).toBe('implement');
  });
});
