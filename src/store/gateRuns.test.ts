import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from './db.js';
import { createTicket } from './tickets.js';
import { setStage } from './stages.js';
import { recordGateRun, listGateRuns } from './gateRuns.js';

describe('gate run evidence', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  it('appends one row per gate, preserving the order they were given', () => {
    const t = createTicket(store, { key: 'A', title: 'a' });
    recordGateRun(store, {
      ticketId: t.id,
      stageKey: 'review',
      attempt: 0,
      runAt: '2026-07-20T12:00:00.000Z',
      gates: [
        { gateName: 'lint', exitCode: 0 },
        { gateName: 'typecheck', exitCode: 0 },
        { gateName: 'test', exitCode: 1 },
      ],
    });

    const runs = listGateRuns(store, t.id);
    expect(runs.map((r) => r.gateName)).toEqual(['lint', 'typecheck', 'test']);
    expect(runs.map((r) => r.exitCode)).toEqual([0, 0, 1]);
    expect(runs.every((r) => r.stageKey === 'review')).toBe(true);
  });

  it('keeps both invocations when two runs share one attempt', () => {
    // `transition` bumps `attempt` only on the failed branch, so review-fail
    // (attempt→1) → fix → review-pass leaves TWO review invocations filed under
    // attempt 1. A natural primary key would collide here and lose the failing
    // run — the exact history this table exists to keep.
    const t = createTicket(store, { key: 'A', title: 'a' });
    const batch = (runAt: string, exit: number) =>
      recordGateRun(store, {
        ticketId: t.id,
        stageKey: 'review',
        attempt: 1,
        runAt,
        gates: [{ gateName: 'test', exitCode: exit }],
      });
    batch('2026-07-20T12:00:00.000Z', 1);
    batch('2026-07-20T12:30:00.000Z', 0);

    const runs = listGateRuns(store, t.id);
    expect(runs).toHaveLength(2);
    expect(runs.map((r) => r.exitCode)).toEqual([1, 0]);
    expect(new Set(runs.map((r) => r.runAt)).size).toBe(2);
  });

  it('round-trips a gate that never ran as null, never as 0', () => {
    // exitCode null = the repo defines no such script. Coercing it to 0 would
    // claim a green suite karst never got to run.
    const t = createTicket(store, { key: 'A', title: 'a' });
    recordGateRun(store, {
      ticketId: t.id,
      stageKey: 'uat',
      attempt: 0,
      runAt: '2026-07-20T12:00:00.000Z',
      gates: [{ gateName: 'test', exitCode: null }],
    });

    const run = listGateRuns(store, t.id)[0]!;
    expect(run.exitCode).toBeNull();
    expect(run.startedAt).toBeNull();
    expect(run.endedAt).toBeNull();
  });

  it('stores the timings a gate reports', () => {
    const t = createTicket(store, { key: 'A', title: 'a' });
    recordGateRun(store, {
      ticketId: t.id,
      stageKey: 'review',
      attempt: 0,
      runAt: '2026-07-20T12:00:00.000Z',
      gates: [
        {
          gateName: 'lint',
          exitCode: 0,
          startedAt: '2026-07-20T12:00:01.000Z',
          endedAt: '2026-07-20T12:00:07.400Z',
        },
      ],
    });

    const run = listGateRuns(store, t.id)[0]!;
    expect(run.startedAt).toBe('2026-07-20T12:00:01.000Z');
    expect(run.endedAt).toBe('2026-07-20T12:00:07.400Z');
  });

  it('scopes reads to one ticket', () => {
    const a = createTicket(store, { key: 'A', title: 'a' });
    const b = createTicket(store, { key: 'B', title: 'b' });
    const seed = (id: number, gate: string) =>
      recordGateRun(store, {
        ticketId: id,
        stageKey: 'review',
        attempt: 0,
        runAt: '2026-07-20T12:00:00.000Z',
        gates: [{ gateName: gate, exitCode: 0 }],
      });
    seed(a.id, 'lint');
    seed(b.id, 'test');

    expect(listGateRuns(store, a.id).map((r) => r.gateName)).toEqual(['lint']);
    expect(listGateRuns(store, b.id).map((r) => r.gateName)).toEqual(['test']);
  });

  it('survives the stage row being overwritten by a retry', () => {
    // `stages` is keyed (ticket_id, stage_key), so a retry overwrites the
    // verdict in place. This table is the only place the prior run survives.
    const t = createTicket(store, { key: 'A', title: 'a' });
    recordGateRun(store, {
      ticketId: t.id,
      stageKey: 'review',
      attempt: 0,
      runAt: '2026-07-20T12:00:00.000Z',
      gates: [{ gateName: 'lint', exitCode: 1 }],
    });
    setStage(store, t.id, 'review', { status: 'passed', verdict: null });

    expect(listGateRuns(store, t.id).map((r) => r.exitCode)).toEqual([1]);
  });

  it('records nothing when a run reports no gates', () => {
    const t = createTicket(store, { key: 'A', title: 'a' });
    recordGateRun(store, {
      ticketId: t.id,
      stageKey: 'review',
      attempt: 0,
      runAt: '2026-07-20T12:00:00.000Z',
      gates: [],
    });
    expect(listGateRuns(store, t.id)).toEqual([]);
  });
});
