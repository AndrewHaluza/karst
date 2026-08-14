import { describe, it, expect, beforeEach } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { createTicket, getTicket } from '../store/tickets.js';
import { getStage, setStage } from '../store/stages.js';
import { openStageRun } from '../store/stageRuns.js';
import { transition } from './machine.js';
import { parkGateStage } from '../store/stageBlocks.js';
import { sendBackState, sendBackToImplement } from './sendBack.js';

function seedPr(
  store: Store,
  ticketId: number,
  repo: string,
  status: string,
  number = 12,
): void {
  store.db
    .prepare('INSERT INTO prs (ticket_id, repo, number, url, status) VALUES (?, ?, ?, ?, ?)')
    .run(ticketId, repo, number, `https://github.com/o/r/pull/${number}`, status);
}

/** Open a genuinely-active run on a gate stage, the way `openGateRun` does. */
function openActiveRun(store: Store, ticketId: number, stage: 'uat' | 'review'): void {
  openStageRun(store, {
    ticketId,
    stageKey: stage,
    attempt: 0,
    runAt: '2026-08-09T10:00:00.000Z',
    pid: 4242,
    startedAt: '2026-08-09T10:00:00.000Z',
  });
}

/** Walk a fresh ticket to a passed gate stage the way the markers leave it. */
function walkTo(store: Store, ticketId: number, stop: 'uat' | 'review' | 'ship'): void {
  const order: ('scope' | 'impl' | 'uat' | 'review')[] =
    stop === 'uat' ? ['scope', 'impl'] : stop === 'review' ? ['scope', 'impl', 'uat'] : ['scope', 'impl', 'uat', 'review'];
  for (const from of order) transition(store, ticketId, from, { kind: 'passed' });
}

describe('sendBackState', () => {
  let store: Store;
  let id: number;
  beforeEach(() => {
    store = openStore(':memory:');
    id = createTicket(store, { key: 'SB-1', title: 't' }).id;
  });

  it('is never available at scope/impl/fix/done', () => {
    // scope (fresh)
    expect(sendBackState(store, id)).toEqual({ available: false, reason: 'stage' });
    // impl (entered but not done)
    transition(store, id, 'scope', { kind: 'passed' });
    expect(sendBackState(store, id)).toEqual({ available: false, reason: 'stage' });
  });

  it('is available at uat once it is settled (passed)', () => {
    walkTo(store, id, 'uat');
    // A passed row is a resting place — the stage is not being driven.
    setStage(store, id, 'uat', { status: 'passed', startedAt: '2026-08-09T10:00:00.000Z' });
    expect(sendBackState(store, id)).toEqual({ available: true, stage: 'uat' });
  });

  it('is available at uat while parked (blocked, not running)', () => {
    walkTo(store, id, 'uat');
    // parkGateStage leaves the runner's stored `running` — the block is what
    // makes the stage settled, never the status.
    parkGateStage(store, {
      ticketId: id,
      stageKey: 'uat',
      kind: 'nothing-to-run',
      reason: 'no worktree resolved',
      runAt: '2026-08-09T10:00:00.000Z',
      gates: [],
    });
    expect(sendBackState(store, id)).toEqual({ available: true, stage: 'uat' });
  });

  it('is available at uat the moment it is entered — before any run opens', () => {
    // The machine enters every gate stage `running` (entryPatch). On its own that
    // column never means "in flight": the driver may not have started, may have
    // been stopped, or the row may predate stage_runs. With no active run the
    // stage is settled and safe to move.
    walkTo(store, id, 'uat');
    expect(getStage(store, id, 'uat')!.status).toBe('running');
    expect(sendBackState(store, id)).toEqual({ available: true, stage: 'uat' });
  });

  it('is withheld at uat while a run is genuinely in flight', () => {
    walkTo(store, id, 'uat');
    // The stage is being DRIVEN: a stage_runs row is open (status 'running').
    openActiveRun(store, id, 'uat');
    expect(sendBackState(store, id)).toEqual({ available: false, reason: 'in-flight' });
  });

  it('is available at uat after a stopped run — settled, nothing in flight', () => {
    walkTo(store, id, 'uat');
    // The user pressed Stop mid-run: the run closed 'stopped', but the stage
    // row still reads 'running' (the stopped path leaves the stored status).
    openActiveRun(store, id, 'uat');
    store.db
      .prepare("UPDATE stage_runs SET status = 'finished', outcome = 'stopped' WHERE ticket_id = ? AND stage_key = ?")
      .run(id, 'uat');
    expect(sendBackState(store, id)).toEqual({ available: true, stage: 'uat' });
  });

  it('is available at review when settled', () => {
    walkTo(store, id, 'review');
    setStage(store, id, 'review', { status: 'passed', startedAt: '2026-08-09T10:00:00.000Z' });
    expect(sendBackState(store, id)).toEqual({ available: true, stage: 'review' });
  });

  it('is withheld at review while its run is in flight', () => {
    walkTo(store, id, 'review');
    openActiveRun(store, id, 'review');
    expect(sendBackState(store, id)).toEqual({ available: false, reason: 'in-flight' });
  });

  it('is available at ship before landing — awaiting confirm with no PR yet', () => {
    walkTo(store, id, 'ship');
    // Freshly parked at ship pending its first confirm click: no PR, no block.
    expect(sendBackState(store, id)).toEqual({ available: true, stage: 'ship' });
  });

  it('is withheld at ship while the shipping saga is running', () => {
    walkTo(store, id, 'ship');
    // stages/ship marks the ship cell 'running' for the duration of the saga —
    // ship records no stage_runs row, so its own cell is the in-flight signal.
    setStage(store, id, 'ship', { status: 'running', endedAt: null });
    expect(sendBackState(store, id)).toEqual({ available: false, reason: 'in-flight' });
  });

  it('is available at ship while awaiting merge', () => {
    walkTo(store, id, 'ship');
    seedPr(store, id, 'api', 'open');
    setStage(store, id, 'ship', { status: 'passed', endedAt: '2026-08-09T10:00:00.000Z' });
    parkGateStage(store, {
      ticketId: id,
      stageKey: 'ship',
      kind: 'awaiting-merge',
      reason: 'blocked: the pull request for "api" has changes and is not merged yet',
      runAt: '2026-08-09T10:33:42.000Z',
      gates: [],
    });
    expect(sendBackState(store, id)).toEqual({ available: true, stage: 'ship' });
  });

  it('is available at ship while conflicted', () => {
    walkTo(store, id, 'ship');
    seedPr(store, id, 'api', 'open');
    setStage(store, id, 'ship', { status: 'passed', endedAt: '2026-08-09T10:00:00.000Z' });
    parkGateStage(store, {
      ticketId: id,
      stageKey: 'ship',
      kind: 'awaiting-merge',
      reason: 'blocked: the pull request for "api" has changes and is not merged yet (a conflict in api)',
      runAt: '2026-08-09T10:33:42.000Z',
      gates: [],
    });
    expect(sendBackState(store, id)).toEqual({ available: true, stage: 'ship' });
  });

  it('is withheld once ANY current PR has merged', () => {
    walkTo(store, id, 'ship');
    seedPr(store, id, 'api', 'merged');
    seedPr(store, id, 'web', 'open', 13);
    expect(sendBackState(store, id)).toEqual({ available: false, reason: 'landed' });
  });

  it('is withheld when fully merged at ship', () => {
    walkTo(store, id, 'ship');
    seedPr(store, id, 'api', 'merged');
    expect(sendBackState(store, id)).toEqual({ available: false, reason: 'landed' });
  });

  it('is withheld at done', () => {
    walkTo(store, id, 'ship');
    seedPr(store, id, 'api', 'merged');
    transition(store, id, 'ship', { kind: 'passed' });
    expect(getTicket(store, id).stageCurrent).toBe('done');
    expect(sendBackState(store, id)).toEqual({ available: false, reason: 'stage' });
  });
});

describe('sendBackToImplement', () => {
  let store: Store;
  let id: number;
  beforeEach(() => {
    store = openStore(':memory:');
    id = createTicket(store, { key: 'SB-2', title: 't' }).id;
  });

  function passedEvidenceStage(stage: 'uat' | 'review', runAt: string): void {
    // gate evidence the recovery must never touch (append-only history)
    store.db
      .prepare(
        `INSERT INTO gate_runs
           (ticket_id, stage_key, attempt, run_at, gate_name, exit_code, started_at, ended_at, repo, command)
         VALUES (?, ?, 0, ?, 'lint', 0, ?, ?, 'api', 'npm run lint')`,
      )
      .run(id, stage, runAt, runAt, runAt);
    setStage(store, id, stage, { status: 'passed', startedAt: runAt, endedAt: runAt, artifactPath: `/tmp/${stage}.log` });
  }

  it('moves a settled uat ticket back to impl and resets downstream rows', () => {
    walkTo(store, id, 'uat');
    passedEvidenceStage('uat', '2026-08-09T10:00:00.000Z');
    const from = sendBackToImplement(store, id, { now: () => '2026-08-09T11:00:00.000Z' });
    expect(from).toEqual({ from: 'uat' });
    const ticket = getTicket(store, id);
    expect(ticket.stageCurrent).toBe('impl');
    const impl = getStage(store, id, 'impl')!;
    expect(impl.status).toBe('running');
    expect(impl.startedAt).toBe('2026-08-09T11:00:00.000Z');
    expect(impl.endedAt).toBeNull();
    expect(impl.verdict).toBeNull();
    // Downstream rows read as "has not run yet" — never as current proof.
    for (const key of ['uat', 'review', 'ship'] as const) {
      const stage = getStage(store, id, key)!;
      expect(stage.status).toBe('pending');
      expect(stage.verdict).toBeNull();
      expect(stage.startedAt).toBeNull();
      expect(stage.endedAt).toBeNull();
      expect(stage.artifactPath).toBeNull();
      expect(stage.blockedKind).toBeNull();
    }
  });

  it('moves a parked (blocked) uat ticket back to impl', () => {
    walkTo(store, id, 'uat');
    parkGateStage(store, {
      ticketId: id,
      stageKey: 'uat',
      kind: 'capability-missing',
      reason: 'playwright missing',
      runAt: '2026-08-09T10:00:00.000Z',
      gates: [],
    });
    sendBackToImplement(store, id, { now: () => '2026-08-09T11:00:00.000Z' });
    expect(getTicket(store, id).stageCurrent).toBe('impl');
    const uat = getStage(store, id, 'uat')!;
    expect(uat.status).toBe('pending');
    expect(uat.blockedKind).toBeNull();
  });

  it('moves a ship ticket back to impl without touching its open PRs', () => {
    walkTo(store, id, 'ship');
    seedPr(store, id, 'api', 'open');
    setStage(store, id, 'ship', { status: 'passed', endedAt: '2026-08-09T10:00:00.000Z' });
    parkGateStage(store, {
      ticketId: id,
      stageKey: 'ship',
      kind: 'awaiting-merge',
      reason: 'blocked: PR for api is not merged yet',
      runAt: '2026-08-09T10:33:42.000Z',
      gates: [],
    });
    const result = sendBackToImplement(store, id, { now: () => '2026-08-09T11:00:00.000Z' });

    expect(result).toEqual({ from: 'ship' });
    expect(getTicket(store, id).stageCurrent).toBe('impl');
    const ship = getStage(store, id, 'ship')!;
    expect(ship.status).toBe('pending');
    expect(ship.blockedKind).toBeNull();
    // The PR row survives — "existing open PRs are not merged/closed".
    const prs = store.db.prepare('SELECT status FROM prs WHERE ticket_id = ?').all(id) as { status: string }[];
    expect(prs).toEqual([{ status: 'open' }]);
  });

  it('preserves append-only gate evidence across the move', () => {
    walkTo(store, id, 'uat');
    passedEvidenceStage('uat', '2026-08-09T10:00:00.000Z');
    passedEvidenceStage('review', '2026-08-09T10:05:00.000Z');
    const before = store.db.prepare('SELECT COUNT(*) AS n FROM gate_runs WHERE ticket_id = ?').get(id) as { n: number };
    sendBackToImplement(store, id, { now: () => '2026-08-09T11:00:00.000Z' });
    const after = store.db.prepare('SELECT COUNT(*) AS n FROM gate_runs WHERE ticket_id = ?').get(id) as { n: number };
    expect(after.n).toBe(before.n);
  });

  it('refuses while a run is in flight (mutates nothing)', () => {
    walkTo(store, id, 'uat');
    openActiveRun(store, id, 'uat');
    expect(() => sendBackToImplement(store, id)).toThrow(/in-flight/);
    expect(getTicket(store, id).stageCurrent).toBe('uat');
  });

  it('refuses once a current PR has merged (mutates nothing)', () => {
    walkTo(store, id, 'ship');
    seedPr(store, id, 'api', 'merged');
    expect(() => sendBackToImplement(store, id)).toThrow(/landed/);
    expect(getTicket(store, id).stageCurrent).toBe('ship');
  });

  it('refuses for stages that never offer the action', () => {
    expect(() => sendBackToImplement(store, id)).toThrow(/not recoverable/);
    transition(store, id, 'scope', { kind: 'passed' });
    expect(() => sendBackToImplement(store, id)).toThrow(/not recoverable/);
  });

  it('re-runs normally on re-entry: entering uat again starts a fresh run', () => {
    walkTo(store, id, 'uat');
    setStage(store, id, 'uat', { status: 'passed', startedAt: '2026-08-09T10:00:00.000Z' });
    sendBackToImplement(store, id, { now: () => '2026-08-09T11:00:00.000Z' });
    // The impl done marker re-enters uat through the machine — a fresh run,
    // never a forward skip from the stale passed row.
    transition(store, id, 'impl', { kind: 'passed' });
    const uat = getStage(store, id, 'uat')!;
    expect(uat.status).toBe('running');
    expect(uat.verdict).toBeNull();
    expect(getTicket(store, id).stageCurrent).toBe('uat');
  });

  it('never creates or implies done', () => {
    walkTo(store, id, 'ship');
    sendBackToImplement(store, id, { now: () => '2026-08-09T11:00:00.000Z' });
    const done = getStage(store, id, 'done')!;
    expect(done.status).toBe('pending');
    expect(getTicket(store, id).stageCurrent).not.toBe('done');
  });
});
