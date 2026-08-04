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

  it('round-trips the v21 invocation identity — repo, command and a JSON args array', () => {
    const t = createTicket(store, { key: 'A', title: 'a' });
    recordGateRun(store, {
      ticketId: t.id,
      stageKey: 'review',
      attempt: 0,
      runAt: '2026-08-01T12:00:00.000Z',
      gates: [
        { gateName: 'test (web)', exitCode: 0, repo: '/web', command: 'npm', args: ['test'] },
      ],
    });

    const run = listGateRuns(store, t.id)[0]!;
    expect(run.repo).toBe('/web');
    expect(run.command).toBe('npm');
    expect(run.args).toEqual(['test']);
  });

  it('stores no args as null, never as an empty-string sentinel', () => {
    const t = createTicket(store, { key: 'A', title: 'a' });
    recordGateRun(store, {
      ticketId: t.id,
      stageKey: 'review',
      attempt: 0,
      runAt: '2026-08-01T12:00:00.000Z',
      gates: [{ gateName: 'lint (web)', exitCode: 0, repo: '/web', command: 'npm', args: [] }],
    });

    const run = listGateRuns(store, t.id)[0]!;
    // An empty args array is a real, meaningful value (a command with no argv)
    // and must round-trip as [], distinct from "no identity given" (null).
    expect(run.args).toEqual([]);
  });

  it('defaults repo/command/args to null when a caller gives none — the "changes" evidence row', () => {
    // The 'changes' row review records when the Changes panel opened is not a
    // gate invocation and carries no identity; every legacy row before v21
    // reads the same way.
    const t = createTicket(store, { key: 'A', title: 'a' });
    recordGateRun(store, {
      ticketId: t.id,
      stageKey: 'review',
      attempt: 0,
      runAt: '2026-08-01T12:00:00.000Z',
      gates: [{ gateName: 'changes', exitCode: 0 }],
    });

    const run = listGateRuns(store, t.id)[0]!;
    expect(run.repo).toBeNull();
    expect(run.command).toBeNull();
    expect(run.args).toBeNull();
  });

  /** Insert a row directly, bypassing `recordGateRun`, to simulate corruption. */
  function insertRawArgs(store: Store, ticketId: number, rawArgs: string): void {
    store.db
      .prepare(
        `INSERT INTO gate_runs
           (ticket_id, stage_key, attempt, run_at, gate_name, exit_code, repo, command, args)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(ticketId, 'review', 0, '2026-08-02T10:00:00.000Z', 'test (web)', 0, '/web', 'npm', rawArgs);
  }

  it('degrades unparseable args to no identity at all, without throwing', () => {
    const t = createTicket(store, { key: 'A', title: 'a' });
    insertRawArgs(store, t.id, 'not json');

    expect(() => listGateRuns(store, t.id)).not.toThrow();
    const run = listGateRuns(store, t.id)[0]!;
    expect(run.args).toBeNull();
    // repo/command degrade WITH args, not left dangling on their own: a
    // partial identity would let `sameGateIdentity` treat the corrupted row's
    // missing args as `[]` and accidentally match a genuinely different,
    // argument-less invocation of the same repo+command.
    expect(run.repo).toBeNull();
    expect(run.command).toBeNull();
  });

  it('degrades JSON that parses but is not a string array (an object) to no identity', () => {
    const t = createTicket(store, { key: 'A', title: 'a' });
    insertRawArgs(store, t.id, '{"not":"an array"}');

    const run = listGateRuns(store, t.id)[0]!;
    expect(run.args).toBeNull();
    expect(run.repo).toBeNull();
    expect(run.command).toBeNull();
  });

  it('degrades JSON that parses but is not a string array (a number) to no identity', () => {
    const t = createTicket(store, { key: 'A', title: 'a' });
    insertRawArgs(store, t.id, '42');

    const run = listGateRuns(store, t.id)[0]!;
    expect(run.args).toBeNull();
    expect(run.repo).toBeNull();
    expect(run.command).toBeNull();
  });

  it('degrades a mixed array (some non-string elements) to no identity', () => {
    const t = createTicket(store, { key: 'A', title: 'a' });
    insertRawArgs(store, t.id, '["test", 1]');

    const run = listGateRuns(store, t.id)[0]!;
    expect(run.args).toBeNull();
    expect(run.repo).toBeNull();
    expect(run.command).toBeNull();
  });

  it('records a skipped gate as skipped, with no exit code and no timing', () => {
    const t = createTicket(store, { key: 'A', title: 'a' });
    recordGateRun(store, {
      ticketId: t.id,
      stageKey: 'uat',
      attempt: 1,
      runAt: '2026-08-04T10:00:00.000Z',
      gates: [{ gateName: 'e2e', exitCode: null, skipped: true }],
    });
    const [row] = listGateRuns(store, t.id);
    expect(row!.skipped).toBe(true);
    expect(row!.exitCode).toBeNull();
    expect(row!.startedAt).toBeNull();
    expect(row!.endedAt).toBeNull();
  });

  it('reads a gate that ran as not skipped', () => {
    const t = createTicket(store, { key: 'A', title: 'a' });
    recordGateRun(store, {
      ticketId: t.id,
      stageKey: 'uat',
      attempt: 1,
      runAt: '2026-08-04T10:00:00.000Z',
      gates: [{ gateName: 'test', exitCode: 0 }],
    });
    expect(listGateRuns(store, t.id)[0]!.skipped).toBe(false);
  });

  it('reads a pre-v24 row (NULL skipped) as not skipped', () => {
    const t = createTicket(store, { key: 'A', title: 'a' });
    store.db
      .prepare(
        `INSERT INTO gate_runs (ticket_id, stage_key, attempt, run_at, gate_name, exit_code, skipped)
         VALUES (?, 'uat', 1, '2026-08-04T10:00:00.000Z', 'test', 0, NULL)`,
      )
      .run(t.id);
    expect(listGateRuns(store, t.id)[0]!.skipped).toBe(false);
  });
});
