import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from './db.js';
import { createTicket } from './tickets.js';
import { openProcessRun } from './processRuns.js';
import { setStage } from './stages.js';
import {
  openShipRun,
  closeShipRun,
  listStrandedShipTickets,
  openShipRepoStep,
  finishShipRepoStep,
  recordShipCommit,
  beginShipOperationPreparation,
  finalizeShipOperationIntent,
  markShipOperationApplied,
  reconcileShipOperation,
  listShipEvidence,
  countShipRuns,
  reconcileShipRuns,
  parseShipPreState,
  parseShipIntent,
  type ShipStep,
  type ShipOperationPreState,
  type ShipOperationIntent,
} from './shipRuns.js';

/**
 * `ship_runs` + `ship_repo_steps` + `ship_operation_intents` + `ship_commits`
 * (v32) — the durable per-repository ship SAGA (Task 9).
 *
 * A ship is a sequence of irreversible external operations (commit, push,
 * PR-description, PR creation) per repo. The registry cannot store git's
 * answer until the operation already happened, so each operation is persisted
 * TWICE around its side effect: a `preparing` ownership row with the complete
 * pre-state BEFORE anything touches git/GitHub, and a `prepared` intent row
 * with the exact intended effect before the apply. A crash mid-saga is then
 * reconciled from those persisted rows — adopted, retried, or marked
 * `ambiguous` — instead of being re-approximated by probing.
 *
 * Same evidence posture as stage_runs/process_runs: append-only, opened at
 * entry, closed at outcome, and a late write is never allowed to overwrite a
 * terminal state.
 */
describe('ship_runs', () => {
  let store: Store;
  let ticketId: number;

  beforeEach(() => {
    store = openStore(':memory:');
    ticketId = createTicket(store, { key: 'T-1', title: 't' }).id;
  });
  afterEach(() => store.close());

  const run = (over: Partial<Parameters<typeof openShipRun>[1]> = {}) =>
    openShipRun(store, {
      ticketId,
      attempt: 1,
      startedAt: '2026-08-08T10:00:00.000Z',
      ...over,
    });

  const step = (shipRunId: number, over: Partial<Parameters<typeof openShipRepoStep>[1]> = {}) =>
    openShipRepoStep(store, {
      shipRunId,
      repo: 'web',
      step: 'commit',
      detail: 'draft',
      startedAt: '2026-08-08T10:01:00.000Z',
      ...over,
    });

  const commitPreState = {
    step: 'commit' as const,
    preHead: 'a'.repeat(40),
    preIndexTree: 'b'.repeat(40),
    worktreeFingerprint: 'wf-1',
    message: 'feat: x',
    author: { name: 'A U Thor', email: 'a@x.test', at: '+0200' },
    committer: { name: 'A U Thor', email: 'a@x.test', at: '+0200' },
    quarantineKey: 'quar-1',
  };
  const commitIntent = {
    step: 'commit' as const,
    intendedTree: 'c'.repeat(40),
    expectedHead: 'd'.repeat(40),
    quarantineKey: 'quar-1',
  };
  const pushPreState = {
    step: 'push' as const,
    localHead: 'e'.repeat(40),
    remote: 'origin',
    ref: 'refs/heads/karst/T-1',
    preRemoteHead: 'f'.repeat(40),
  };
  const pushIntent = {
    step: 'push' as const,
    localHead: 'e'.repeat(40),
    remote: 'origin',
    ref: 'refs/heads/karst/T-1',
    preRemoteHead: 'f'.repeat(40),
  };
  const describePreState = {
    step: 'describe' as const,
    prUrl: 'https://github.test/o/r/pull/413',
    preBodyHash: 'h1',
  };
  const describeIntent = {
    step: 'describe' as const,
    prUrl: 'https://github.test/o/r/pull/413',
    preBodyHash: 'h1',
    intendedBody: 'body v2',
  };
  const prPreState = {
    step: 'pr' as const,
    head: 'karst/T-1',
    base: 'main',
    preExistingUrl: null,
  };
  const prIntent = {
    step: 'pr' as const,
    head: 'karst/T-1',
    base: 'main',
    title: 'T-1',
    body: 'body',
    preExistingUrl: null,
  };

  const preStates: Record<ShipStep, ShipOperationPreState> = {
    commit: commitPreState,
    push: pushPreState,
    describe: describePreState,
    pr: prPreState,
  };
  const intents: Record<ShipStep, ShipOperationIntent> = {
    commit: commitIntent,
    push: pushIntent,
    describe: describeIntent,
    pr: prIntent,
  };

  const begin = (
    shipRunId: number,
    s: ShipStep,
    over: Partial<Parameters<typeof beginShipOperationPreparation>[1]> = {},
  ) =>
    beginShipOperationPreparation(store, {
      shipRunId,
      repo: 'web',
      step: s,
      operationKey: `web:${s}`,
      preState: preStates[s],
      createdAt: '2026-08-08T10:01:00.000Z',
      ...over,
    });

  it('opens a ship run as running, carrying its attempt', () => {
    const r = run();
    expect(r).toMatchObject({
      ticketId,
      attempt: 1,
      status: 'running',
      startedAt: '2026-08-08T10:00:00.000Z',
      endedAt: null,
    });
    expect(r.id).toBeGreaterThan(0);
  });

  it('opens a repo step as running with its detail and process link', () => {
    const r = run();
    const processRunId = openProcessRun(store, {
      ticketId,
      stageKey: 'ship',
      processId: 'commit',
      attempt: 1,
      startedAt: '2026-08-08T10:00:30.000Z',
    }).id;
    const s = step(r.id, { step: 'push', processRunId });
    expect(s).toMatchObject({
      shipRunId: r.id,
      repo: 'web',
      step: 'push',
      status: 'running',
      detail: 'draft',
      prNumber: null,
      existedBeforeShip: null,
      processRunId,
      operationIntentId: null,
      startedAt: '2026-08-08T10:01:00.000Z',
      endedAt: null,
    });
    expect(s.id).toBeGreaterThan(0);
  });

  it('finishes a step terminally and only from running', () => {
    const r = run();
    const s = step(r.id, { step: 'push' });
    finishShipRepoStep(store, s.id, {
      status: 'passed',
      detail: 'pushed d…',
      prNumber: 413,
      existedBeforeShip: false,
      endedAt: '2026-08-08T10:02:00.000Z',
    });
    const ev = listShipEvidence(store, ticketId);
    expect(ev.repos.web!.push).toMatchObject({
      status: 'passed',
      detail: 'pushed d…',
      prNumber: 413,
      existedBeforeShip: false,
      endedAt: '2026-08-08T10:02:00.000Z',
    });

    // A second finish of an already-closed step must not rewrite its outcome.
    finishShipRepoStep(store, s.id, {
      status: 'failed',
      detail: 'late failure',
      endedAt: '2026-08-08T10:03:00.000Z',
    });
    expect(listShipEvidence(store, ticketId).repos.web!.push).toMatchObject({
      status: 'passed',
      detail: 'pushed d…',
      endedAt: '2026-08-08T10:02:00.000Z',
    });
  });

  it('records commits with both origins', () => {
    const r = run();
    recordShipCommit(store, {
      shipRunId: r.id,
      repo: 'api',
      sha: 'f'.repeat(40),
      message: 'existing work',
      origin: 'before-ship',
    });
    recordShipCommit(store, {
      shipRunId: r.id,
      repo: 'api',
      sha: 'g'.repeat(40),
      message: 'feat: ship it',
      origin: 'created-by-ship',
    });
    const ev = listShipEvidence(store, ticketId);
    expect(ev.repos.api!.commits.map((c) => c.origin)).toEqual([
      'before-ship',
      'created-by-ship',
    ]);
    expect(ev.repos.api!.commits[0]).toMatchObject({
      repo: 'api',
      sha: 'f'.repeat(40),
      message: 'existing work',
    });
  });

  it.each(['commit', 'push', 'describe', 'pr'] as const)(
    'runs the full prepare→finalize→apply→reconcile lifecycle for step %s',
    (s) => {
      const r = run();
      const intent = begin(r.id, s);
      expect(intent).toMatchObject({
        shipRunId: r.id,
        repo: 'web',
        step: s,
        operationKey: `web:${s}`,
        status: 'preparing',
        intentJson: null,
        createdAt: '2026-08-08T10:01:00.000Z',
        preparedAt: null,
        appliedAt: null,
        resolvedAt: null,
      });
      // The complete immutable pre-state is durable BEFORE anything touched
      // git/GitHub, and round-trips through the closed union.
      expect(parseShipPreState(intent.preStateJson, s)).toEqual(preStates[s]);

      finalizeShipOperationIntent(store, intent.id, intents[s], '2026-08-08T10:02:00.000Z');
      markShipOperationApplied(store, intent.id, {
        appliedAt: '2026-08-08T10:03:00.000Z',
      });
      reconcileShipOperation(store, intent.id, 'reconciled', {
        resolvedAt: '2026-08-08T10:03:30.000Z',
      });

      const ev = listShipEvidence(store, ticketId);
      const row = ev.repos.web!.intents[s]!;
      expect(row).toMatchObject({
        status: 'reconciled',
        preparedAt: '2026-08-08T10:02:00.000Z',
        appliedAt: '2026-08-08T10:03:00.000Z',
        resolvedAt: '2026-08-08T10:03:30.000Z',
      });
      expect(parseShipIntent(row.intentJson, s)).toEqual(intents[s]);
    },
  );

  it('records each terminal reconcile status: reconciled, failed, ambiguous', () => {
    const r = run();
    for (const [s, status] of [
      ['commit', 'reconciled'],
      ['push', 'failed'],
      ['describe', 'ambiguous'],
      ['pr', 'failed'],
    ] as const) {
      const intent = begin(r.id, s, { operationKey: `web:${s}-${status}` });
      finalizeShipOperationIntent(store, intent.id, intents[s], '2026-08-08T10:02:00.000Z');
      markShipOperationApplied(store, intent.id, { appliedAt: '2026-08-08T10:03:00.000Z' });
      reconcileShipOperation(store, intent.id, status, { resolvedAt: '2026-08-08T10:04:00.000Z' });
    }
    const ev = listShipEvidence(store, ticketId);
    expect(ev.repos.web!.intents.commit!.status).toBe('reconciled');
    expect(ev.repos.web!.intents.push!.status).toBe('failed');
    expect(ev.repos.web!.intents.describe!.status).toBe('ambiguous');
    expect(ev.repos.web!.intents.pr!.status).toBe('failed');
  });

  it('finalize is refused once the row left preparing', () => {
    const r = run();
    const intent = begin(r.id, 'push');
    finalizeShipOperationIntent(store, intent.id, intents.push, '2026-08-08T10:02:00.000Z');
    markShipOperationApplied(store, intent.id, { appliedAt: '2026-08-08T10:03:00.000Z' });

    // A late finalize from `applied` must not overwrite the recorded intent.
    finalizeShipOperationIntent(store, intent.id, pushIntent, '2026-08-08T10:05:00.000Z');
    const row = listShipEvidence(store, ticketId).repos.web!.intents.push!;
    expect(row).toMatchObject({
      status: 'applied',
      preparedAt: '2026-08-08T10:02:00.000Z',
      appliedAt: '2026-08-08T10:03:00.000Z',
    });
  });

  it('reconcile is a no-op on an already-terminal row', () => {
    const r = run();
    const intent = begin(r.id, 'commit');
    finalizeShipOperationIntent(store, intent.id, intents.commit, '2026-08-08T10:02:00.000Z');
    markShipOperationApplied(store, intent.id, { appliedAt: '2026-08-08T10:03:00.000Z' });
    reconcileShipOperation(store, intent.id, 'ambiguous', {
      resolvedAt: '2026-08-08T10:04:00.000Z',
    });

    // A second reconcile must not rewrite the terminal outcome.
    reconcileShipOperation(store, intent.id, 'reconciled', {
      resolvedAt: '2026-08-08T10:05:00.000Z',
    });
    const row = listShipEvidence(store, ticketId).repos.web!.intents.commit!;
    expect(row.status).toBe('ambiguous');
    expect(row.resolvedAt).toBe('2026-08-08T10:04:00.000Z');
  });

  it('applies the idempotency guard on operation_key: a rerun gets the durable row back', () => {
    const r = run();
    const first = begin(r.id, 'commit');
    // A retry (or a crash-and-rerun) prepares the SAME operation: the guard
    // must hand back the existing ownership row, not create a second one —
    // the durable pre-state is the only thing that can authorize reconciliation.
    const again = begin(r.id, 'commit', {
      preState: { ...commitPreState, preHead: 'z'.repeat(40) },
      createdAt: '2026-08-08T11:00:00.000Z',
    });
    expect(again.id).toBe(first.id);
    const pre = parseShipPreState(
      again.preStateJson,
      'commit',
    ) as Extract<ShipOperationPreState, { step: 'commit' }>;
    expect(pre.preHead).toBe('a'.repeat(40));
    const ev = listShipEvidence(store, ticketId);
    expect(ev.repos.web!.intents.commit!.id).toBe(first.id);
  });

  describe('parseShipPreState / parseShipIntent', () => {
    it('round-trips every step shape through both unions', () => {
      for (const s of ['commit', 'push', 'describe', 'pr'] as const) {
        const json = JSON.stringify(preStates[s]);
        expect(parseShipPreState(json, s)).toEqual(preStates[s]);
        expect(parseShipIntent(JSON.stringify(intents[s]), s)).toEqual(intents[s]);
      }
    });

    it('returns null for non-JSON, null input, and structurally wrong data', () => {
      expect(parseShipPreState('not json', 'commit')).toBeNull();
      expect(parseShipPreState(null, 'commit')).toBeNull();
      expect(parseShipPreState(undefined, 'commit')).toBeNull();
      expect(parseShipPreState('null', 'commit')).toBeNull();
      expect(parseShipPreState('[]', 'commit')).toBeNull();
      expect(parseShipPreState('"str"', 'commit')).toBeNull();
      // An unknown step never matches any union member (a foreign writer can
      // store any TEXT; the parser must not fall through to a match).
      const foreignStep = JSON.stringify({ ...commitPreState, step: 'merge' });
      expect(parseShipPreState(foreignStep, 'merge' as ShipStep)).toBeNull();
      // A step/type mismatch is malformed, never coerced.
      expect(parseShipPreState(JSON.stringify(commitPreState), 'push')).toBeNull();
      // Missing and mistyped fields are malformed.
      const { preHead: _drop, ...missing } = commitPreState;
      expect(parseShipPreState(JSON.stringify(missing), 'commit')).toBeNull();
      expect(
        parseShipPreState(JSON.stringify({ ...commitPreState, preHead: 42 }), 'commit'),
      ).toBeNull();
      // An empty preIndexTree is a failed `git write-tree` read that must never
      // be adopted: the CAS would otherwise compare the real tree against `''`.
      expect(
        parseShipPreState(JSON.stringify({ ...commitPreState, preIndexTree: '' }), 'commit'),
      ).toBeNull();
      expect(
        parseShipPreState(JSON.stringify({ ...commitPreState, author: { name: 'x' } }), 'commit'),
      ).toBeNull();

      expect(parseShipIntent('garbage', 'push')).toBeNull();
      expect(parseShipIntent(null, 'push')).toBeNull();
      expect(parseShipIntent(JSON.stringify(intents.push), 'commit')).toBeNull();
      expect(
        parseShipIntent(JSON.stringify({ ...intents.push, localHead: 7 }), 'push'),
      ).toBeNull();
      // A nullable field may be null, but may not be missing or mistyped.
      expect(parseShipIntent(JSON.stringify({ ...intents.pr, base: null }), 'pr')).toEqual({
        ...intents.pr,
        base: null,
      });
      const { title: _drop2, ...missingTitle } = intents.pr as Extract<
        ShipOperationIntent,
        { step: 'pr' }
      >;
      expect(parseShipIntent(JSON.stringify(missingTitle), 'pr')).toBeNull();
    });
  });

  describe('listShipEvidence', () => {
    it('shapes per-repo evidence keyed by step, with the run and ordered commits', () => {
      const r = run();
      step(r.id, { step: 'push', repo: 'web' });
      step(r.id, { step: 'pr', repo: 'web', detail: 'opened' });
      const ev0 = listShipEvidence(store, ticketId);
      finishShipRepoStep(store, ev0.repos.web!.push!.id, {
        status: 'passed',
        endedAt: '2026-08-08T10:02:00.000Z',
      });
      finishShipRepoStep(store, ev0.repos.web!.pr!.id, {
        status: 'passed',
        detail: 'opened',
        prNumber: 413,
        existedBeforeShip: false,
        endedAt: '2026-08-08T10:02:30.000Z',
      });
      recordShipCommit(store, {
        shipRunId: r.id,
        repo: 'api',
        sha: 'f'.repeat(40),
        message: 'existing work',
        origin: 'before-ship',
      });
      begin(r.id, 'describe', { repo: 'api', operationKey: 'api:describe' });

      const ev = listShipEvidence(store, ticketId);
      expect(ev.run).toMatchObject({ id: r.id, ticketId, status: 'running' });
      // The task's exact access shapes.
      expect(ev.repos.web!.push!.status).toBe('passed');
      expect(ev.repos.web!.pr!.number).toBe(413);
      expect(ev.repos.api!.commits[0]!.origin).toBe('before-ship');
      expect(ev.repos.web!.pr!.existedBeforeShip).toBe(false);
      expect(ev.repos.api!.intents.describe!.status).toBe('preparing');
    });

    it('uses the LATEST ship run for the ticket, leaving earlier runs out', () => {
      const first = run({ attempt: 1 });
      recordShipCommit(store, {
        shipRunId: first.id,
        repo: 'web',
        sha: 'f'.repeat(40),
        message: 'old',
        origin: 'created-by-ship',
      });
      const second = run({ attempt: 2, startedAt: '2026-08-08T12:00:00.000Z' });
      recordShipCommit(store, {
        shipRunId: second.id,
        repo: 'api',
        sha: 'g'.repeat(40),
        message: 'new',
        origin: 'created-by-ship',
      });

      const ev = listShipEvidence(store, ticketId);
      expect(ev.run!.id).toBe(second.id);
      expect(ev.run!.attempt).toBe(2);
      expect(ev.repos.web).toBeUndefined();
      expect(ev.repos.api!.commits).toHaveLength(1);
      expect(ev.repos.api!.commits[0]!.sha).toBe('g'.repeat(40));
    });

    it('never mixes another ticket into the evidence', () => {
      const other = createTicket(store, { key: 'T-2', title: 'other' }).id;
      const r = run();
      const otherRun = openShipRun(store, {
        ticketId: other,
        attempt: 1,
        startedAt: '2026-08-08T10:00:00.000Z',
      });
      step(r.id);
      step(otherRun.id, { repo: 'other-repo' });
      const ev = listShipEvidence(store, ticketId);
      expect(ev.run!.id).toBe(r.id);
      expect(ev.repos.web).toBeDefined();
      expect(ev.repos['other-repo']).toBeUndefined();
    });

    it('lists a running step with no matching intent row, flagged so the caller refuses preparation', () => {
      const r = run();
      const s = step(r.id, { step: 'push' });
      const ev = listShipEvidence(store, ticketId);
      const push = ev.repos.web!.push!;
      expect(push.id).toBe(s.id);
      expect(push.status).toBe('running');
      expect(push.hasIntent).toBe(false);
      // The same step is no longer flagged once its preparation row exists.
      begin(r.id, 'push');
      expect(listShipEvidence(store, ticketId).repos.web!.push!.hasIntent).toBe(true);
    });

    it('returns an empty repos map when the ticket has no ship run', () => {
      const ev = listShipEvidence(store, ticketId);
      expect(ev.run).toBeUndefined();
      expect(ev.repos).toEqual({});
    });
  });

  describe('listStrandedShipTickets', () => {
    // The freeze this sweep closes: `shipTicket` set the stage row `running`,
    // then the extension host died before its tail ran. The ticket sits at
    // `ship` reading `running` with a `running` ship_runs row and NO
    // awaiting-merge block — so settleShipGates skips it, the drive sweep
    // covers only uat/review, and the dashboard offers no button for a running
    // row. Nothing else ever re-drives the saga.
    const atShipRunning = (id: number): void => {
      setStage(store, id, 'ship', {
        status: 'running',
        startedAt: '2026-08-08T11:00:00.000Z',
      });
      store.db.prepare("UPDATE tickets SET stage_current = 'ship' WHERE id = ?").run(id);
    };

    it('finds a ticket whose ship run was opened by a now-dead host', () => {
      const r = openShipRun(store, {
        ticketId,
        attempt: 1,
        startedAt: '2026-08-08T11:00:00.000Z',
        pid: 4242,
      });
      atShipRunning(ticketId);
      expect(listStrandedShipTickets(store, (pid) => pid !== 4242)).toEqual([
        { ticketId, runId: r.id, startedAt: '2026-08-08T11:00:00.000Z', pid: 4242 },
      ]);
    });

    it('leaves a ship another LIVE window is still executing strictly alone', () => {
      openShipRun(store, {
        ticketId,
        attempt: 1,
        startedAt: '2026-08-08T11:00:00.000Z',
        pid: 4242,
      });
      atShipRunning(ticketId);
      expect(listStrandedShipTickets(store, () => true)).toEqual([]);
    });

    it('treats a run with no recorded pid as stranded — absence of evidence is not evidence of life', () => {
      // A pre-v34 run (or a run whose host died before the pid landed) carries
      // no liveness evidence at all; leaving it alone would keep the freeze
      // forever, so it is recoverable exactly like a proven-dead one.
      const r = openShipRun(store, { ticketId, attempt: 1, startedAt: '2026-08-08T11:00:00.000Z' });
      atShipRunning(ticketId);
      expect(listStrandedShipTickets(store, () => true)).toEqual([
        { ticketId, runId: r.id, startedAt: '2026-08-08T11:00:00.000Z', pid: null },
      ]);
    });

    it('strands a running stage row whose run never opened (crash between dispatch and run open)', () => {
      atShipRunning(ticketId);
      const stranded = listStrandedShipTickets(store, () => true);
      expect(stranded).toHaveLength(1);
      // No run exists to name, but the stage row's own start stamp still dates
      // the interrupted ship.
      expect(stranded[0]).toEqual({
        ticketId,
        runId: null,
        startedAt: '2026-08-08T11:00:00.000Z',
        pid: null,
      });
    });

    it('ignores a freshly parked ship — stage row pending, no run — the human has not clicked yet', () => {
      // The machine-produced parked state: review→ship transition writes a
      // `pending` ship stage row (`ship` is a confirm stage), so the stranded
      // sweep's `s.status = 'running'` filter excludes it. A `pending` row is
      // the shape to pin — a missing row would also pass, but only by accident.
      setStage(store, ticketId, 'ship', {
        status: 'pending',
        startedAt: '2026-08-08T11:00:00.000Z',
      });
      store.db.prepare("UPDATE tickets SET stage_current = 'ship' WHERE id = ?").run(ticketId);
      expect(listStrandedShipTickets(store, () => false)).toEqual([]);
    });

    it('ignores a ship parked on the merge gate (passed row with an awaiting-merge block)', () => {
      const r = openShipRun(store, {
        ticketId,
        attempt: 1,
        startedAt: '2026-08-08T11:00:00.000Z',
        pid: 4242,
      });
      closeShipRun(store, r.id, 'passed', '2026-08-08T11:05:00.000Z');
      setStage(store, ticketId, 'ship', {
        status: 'passed',
        endedAt: '2026-08-08T11:05:00.000Z',
        blockedKind: 'awaiting-merge',
        blockedReason: 'blocked: the pull request has changes and is not merged yet.',
        blockedAt: '2026-08-08T11:05:00.000Z',
      });
      store.db.prepare("UPDATE tickets SET stage_current = 'ship' WHERE id = ?").run(ticketId);
      expect(listStrandedShipTickets(store, () => false)).toEqual([]);
    });

    it('ignores a ship stage row reading running when the ticket has already left ship', () => {
      openShipRun(store, {
        ticketId,
        attempt: 1,
        startedAt: '2026-08-08T11:00:00.000Z',
        pid: 4242,
      });
      setStage(store, ticketId, 'ship', { status: 'running' });
      // stage_current stays 'uat' — a running legacy ship row is not this
      // ticket's current state, so nothing at ship is stranded.
      expect(listStrandedShipTickets(store, () => false)).toEqual([]);
    });

    it('respects the project scope', () => {
      store.db.prepare('INSERT INTO projects (id, slug) VALUES (?, ?)').run(1, 'karst');
      store.db.prepare('INSERT INTO projects (id, slug) VALUES (?, ?)').run(2, 'other');
      const other = createTicket(store, { key: 'T-2', title: 'other', projectId: 2 }).id;
      openShipRun(store, {
        ticketId: other,
        attempt: 1,
        startedAt: '2026-08-08T11:00:00.000Z',
        pid: 4242,
      });
      atShipRunning(other);
      const stranded = listStrandedShipTickets(store, () => false, { projectId: 1 });
      expect(stranded).toEqual([]);
      expect(listStrandedShipTickets(store, () => false, { projectId: 2 })).toEqual([
        { ticketId: other, runId: expect.any(Number) as number, startedAt: '2026-08-08T11:00:00.000Z', pid: 4242 },
      ]);
    });
  });

  describe('reconcileShipRuns', () => {
    const parkAtShip = () => {
      setStage(store, ticketId, 'ship', {
        status: 'running',
        startedAt: '2026-08-08T10:00:00.000Z',
      });
      store.db.prepare("UPDATE tickets SET stage_current = 'ship' WHERE id = ?").run(ticketId);
    };

    it('carries the opening host pid on the run row', () => {
      const r = run({ pid: 4242 });
      expect(r.pid).toBe(4242);
      expect(listShipEvidence(store, ticketId).run!.pid).toBe(4242);
    });

    it('marks a dead run interrupted, closes its running steps failed, and parks the stage for a retry', () => {
      parkAtShip();
      const r = run({ pid: 4242 });
      const describe = step(r.id, { step: 'describe' });
      step(r.id, { step: 'commit', repo: 'api' });

      const stale = reconcileShipRuns(store, (pid) => pid !== 4242, '2026-08-08T11:00:00.000Z');
      expect(stale).toHaveLength(1);
      expect(stale[0]!.run.id).toBe(r.id);
      expect(stale[0]!.run.status).toBe('interrupted');
      expect(stale[0]!.reason).toMatch(/pid 4242/);

      const ev = listShipEvidence(store, ticketId);
      expect(ev.run).toMatchObject({ status: 'interrupted', endedAt: '2026-08-08T11:00:00.000Z' });
      expect(ev.repos.web!.describe).toMatchObject({
        status: 'failed',
        detail: 'interrupted — the host that ran it died; retry ship to continue',
        endedAt: '2026-08-08T11:00:00.000Z',
      });
      expect(ev.repos.api!.commit).toMatchObject({ status: 'failed' });

      // The stage reads failed with a retry verdict, so the existing
      // failed-ship surface ("Retry ship") explains the interruption.
      const stage = store.db
        .prepare("SELECT status, verdict, ended_at FROM stages WHERE ticket_id = ? AND stage_key = 'ship'")
        .get(ticketId) as { status: string; verdict: string; ended_at: string | null };
      expect(stage.status).toBe('failed');
      expect(stage.verdict).toMatch(/interrupted/);
      expect(stage.ended_at).toBe('2026-08-08T11:00:00.000Z');
    });

    it('leaves a run whose pid is still alive strictly alone', () => {
      parkAtShip();
      const r = run({ pid: 4242 });
      step(r.id, { step: 'describe' });
      const stale = reconcileShipRuns(store, () => true, '2026-08-08T11:00:00.000Z');
      expect(stale).toEqual([]);
      const ev = listShipEvidence(store, ticketId);
      expect(ev.run!.status).toBe('running');
      expect(ev.run!.endedAt).toBeNull();
      expect(ev.repos.web!.describe!.status).toBe('running');
      const stage = store.db
        .prepare("SELECT status FROM stages WHERE ticket_id = ? AND stage_key = 'ship'")
        .get(ticketId) as { status: string };
      expect(stage.status).toBe('running');
    });

    it('leaves a run with no recorded pid alone — absence of evidence is not evidence it died', () => {
      parkAtShip();
      const r = run();
      step(r.id, { step: 'describe' });
      const stale = reconcileShipRuns(store, () => false, '2026-08-08T11:00:00.000Z');
      expect(stale).toEqual([]);
      expect(listShipEvidence(store, ticketId).run!.status).toBe('running');
    });

    it('never rewrites an already-closed run', () => {
      parkAtShip();
      const r = run({ pid: 4242 });
      closeShipRun(store, r.id, 'passed', '2026-08-08T10:30:00.000Z');
      const stale = reconcileShipRuns(store, () => false, '2026-08-08T11:00:00.000Z');
      expect(stale).toEqual([]);
      expect(listShipEvidence(store, ticketId).run!.status).toBe('passed');
    });

    it('closes the dead run but leaves the stage alone when the stage is blocked, not running', () => {
      // A ticket parked awaiting-merge keeps its stored `running` beside the
      // block; a dead run must not flip that parked state to failed.
      setStage(store, ticketId, 'ship', {
        status: 'running',
        startedAt: '2026-08-08T10:00:00.000Z',
        blockedKind: 'awaiting-merge',
        blockedReason: 'PR #413 not merged',
        blockedAt: '2026-08-08T10:30:00.000Z',
      });
      const r = run({ pid: 4242 });
      reconcileShipRuns(store, () => false, '2026-08-08T11:00:00.000Z');
      expect(listShipEvidence(store, ticketId).run!.status).toBe('interrupted');
      const stage = store.db
        .prepare("SELECT status, blocked_kind FROM stages WHERE ticket_id = ? AND stage_key = 'ship'")
        .get(ticketId) as { status: string; blocked_kind: string | null };
      expect(stage.status).toBe('running');
      expect(stage.blocked_kind).toBe('awaiting-merge');
    });

    it('is idempotent: a second sweep finds nothing left to mark', () => {
      parkAtShip();
      run({ pid: 4242 });
      reconcileShipRuns(store, () => false, '2026-08-08T11:00:00.000Z');
      expect(reconcileShipRuns(store, () => false, '2026-08-08T11:05:00.000Z')).toEqual([]);
    });
  });

  describe('countShipRuns', () => {
    it('counts every recorded ship run, including superseded ones', () => {
      expect(countShipRuns(store, ticketId)).toBe(0);
      const r1 = run();
      closeShipRun(store, r1.id, 'passed', '2026-08-08T10:30:00.000Z');
      const r2 = run();
      closeShipRun(store, r2.id, 'failed', '2026-08-08T11:00:00.000Z');
      expect(countShipRuns(store, ticketId)).toBe(2);
    });

    it('is scoped to the ticket', () => {
      run();
      const other = createTicket(store, { key: 'SHIP-2', title: 'other' });
      expect(countShipRuns(store, other.id)).toBe(0);
    });
  });
});
