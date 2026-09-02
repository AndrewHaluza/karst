import { describe, it, expect, beforeEach } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { createTicket, getTicket } from '../store/tickets.js';
import { getStage, setStage } from '../store/stages.js';
import { transition } from './machine.js';
import {
  openRecoveryRound,
  listRecoveryRounds,
  activeRecoverySeries,
  beginLiveFixExecution,
} from '../store/recoveryRounds.js';
import { resetStageState, resetGateStage, type ResetStageState } from './resetStage.js';

const T0 = '2026-08-01T10:00:00.000Z';
const T1 = '2026-08-01T11:00:00.000Z';
const T2 = '2026-08-01T12:00:00.000Z';

/** Walk a fresh ticket to uat the way the markers leave it. */
function walkToUat(store: Store, ticketId: number): void {
  transition(store, ticketId, 'scope', { kind: 'passed' });
  transition(store, ticketId, 'impl', { kind: 'passed' });
}

function exhaustRound(store: Store, ticketId: number, stage: 'uat' | 'review'): void {
  const r = openRecoveryRound(store, {
    ticketId,
    sourceStage: stage,
    sourceProcessId: 'gates',
    sourceStageRunId: null,
    sourceProcessRunId: null,
    triggerKind: 'gate-failure',
    triggerDetail: 'exit 1',
    maxRounds: 3,
    startedAt: T0,
  });
  store.db
    .prepare("UPDATE recovery_rounds SET status = 'exhausted', ended_at = ? WHERE id = ?")
    .run(T1, r.id);
}

describe('resetStageState', () => {
  let store: Store;
  let id: number;
  beforeEach(() => {
    store = openStore(':memory:');
    id = createTicket(store, { key: 'RS-1', title: 't' }).id;
  });

  it('is never available at scope/impl/fix/done', () => {
    expect(resetStageState(store, id)).toEqual({ available: false, reason: 'stage' });
    transition(store, id, 'scope', { kind: 'passed' });
    expect(resetStageState(store, id)).toEqual({ available: false, reason: 'stage' });
  });

  it('is available at uat when the stage is failed', () => {
    walkToUat(store, id);
    transition(store, id, 'uat', { kind: 'failed', reason: 'exit 1' }); // → fix
    // The ticket is at fix, but the UAT stage row reads 'failed'.
    expect(resetStageState(store, id)).toEqual({ available: true, stage: 'uat' });
  });

  it('is available at review when the stage is failed', () => {
    walkToUat(store, id);
    transition(store, id, 'uat', { kind: 'passed' });
    transition(store, id, 'review', { kind: 'failed', reason: 'findings' }); // → fix
    expect(resetStageState(store, id)).toEqual({ available: true, stage: 'review' });
  });

  it('is available at uat when the stage is exhausted (parked at fix)', () => {
    walkToUat(store, id);
    transition(store, id, 'uat', { kind: 'failed', reason: 'exit 1' }); // → fix
    exhaustRound(store, id, 'uat');
    // Ticket rests at fix with an exhausted round — the dashboard offers reset.
    expect(resetStageState(store, id)).toEqual({ available: true, stage: 'uat' });
  });

  it('is withheld while a fix execution is in flight', () => {
    walkToUat(store, id);
    transition(store, id, 'uat', { kind: 'failed', reason: 'exit 1' }); // → fix
    const r = openRecoveryRound(store, {
      ticketId: id,
      sourceStage: 'uat',
      sourceProcessId: 'gates',
      sourceStageRunId: null,
      sourceProcessRunId: null,
      triggerKind: 'gate-failure',
      triggerDetail: 'exit 1',
      maxRounds: 3,
      startedAt: T0,
    });
    beginLiveFixExecution(store, { ticketId: id, roundId: r.id, startedAt: T1 });
    expect(resetStageState(store, id)).toEqual({ available: false, reason: 'in-flight' });
  });

  it('is withheld when no gate stage is failed', () => {
    walkToUat(store, id);
    // uat is running, not failed — nothing to reset.
    expect(getStage(store, id, 'uat')!.status).toBe('running');
    expect(resetStageState(store, id)).toEqual({ available: false, reason: 'stage' });
  });
});

describe('resetGateStage', () => {
  let store: Store;
  let id: number;
  beforeEach(() => {
    store = openStore(':memory:');
    id = createTicket(store, { key: 'RS-2', title: 't' }).id;
  });

  it('resets a failed uat stage to pending and closes recovery rounds', () => {
    walkToUat(store, id);
    transition(store, id, 'uat', { kind: 'failed', reason: 'exit 1' }); // → fix
    exhaustRound(store, id, 'uat');
    // The fix stage reads running/parked; the ticket is at fix.
    expect(getTicket(store, id).stageCurrent).toBe('fix');

    const result = resetGateStage(store, id, { now: () => T2 });
    expect(result).toEqual({ stage: 'uat' });

    const uat = getStage(store, id, 'uat')!;
    // The stage is re-entered `running` (the machine's entryPatch for a gate
    // stage), not left `pending` — deriveStageCurrent would skip a pending
    // stage with startedAt === null on reload (reconcile.ts:53).
    expect(uat.status).toBe('running');
    expect(uat.attempt).toBe(0);
    expect(uat.verdict).toBeNull();
    expect(uat.startedAt).toBe(T2);
    expect(uat.endedAt).toBeNull();

    // The exhausted round is now 'reset' — terminal, excluded from the active series.
    const rounds = listRecoveryRounds(store, id);
    expect(rounds[0]!.status).toBe('reset');
    expect(activeRecoverySeries(store, id, 'uat')).toBeNull();

    // The ticket moves back to uat so the gates re-run.
    expect(getTicket(store, id).stageCurrent).toBe('uat');
  });

  it('resets a failed review stage', () => {
    walkToUat(store, id);
    transition(store, id, 'uat', { kind: 'passed' });
    transition(store, id, 'review', { kind: 'failed', reason: 'findings' }); // → fix
    exhaustRound(store, id, 'review');

    const result = resetGateStage(store, id, { now: () => T2 });
    expect(result).toEqual({ stage: 'review' });

    const review = getStage(store, id, 'review')!;
    expect(review.status).toBe('running');
    expect(review.attempt).toBe(0);
    expect(review.verdict).toBeNull();
    expect(getTicket(store, id).stageCurrent).toBe('review');
  });

  it('re-stamps the fix row as pending (no longer parked)', () => {
    walkToUat(store, id);
    transition(store, id, 'uat', { kind: 'failed', reason: 'exit 1' }); // → fix
    exhaustRound(store, id, 'uat');
    // exhaustRecoveryRound parks the fix stage as 'failed' — simulate that.
    store.db
      .prepare(
        "UPDATE stages SET status = 'failed', verdict = 'fix attempts exhausted' WHERE ticket_id = ? AND stage_key = 'fix'",
      )
      .run(id);
    expect(getStage(store, id, 'fix')!.status).toBe('failed');

    resetGateStage(store, id, { now: () => T2 });

    const fix = getStage(store, id, 'fix')!;
    expect(fix.status).toBe('pending');
    expect(fix.verdict).toBeNull();
  });

  it('the next failure opens a fresh episode (the reset round ended the episode)', () => {
    walkToUat(store, id);
    transition(store, id, 'uat', { kind: 'failed', reason: 'exit 1' }); // → fix
    exhaustRound(store, id, 'uat');
    resetGateStage(store, id, { now: () => T2 });

    // Re-run uat and fail again — the new round should be episode 2, round 1.
    transition(store, id, 'uat', { kind: 'failed', reason: 'exit 2' }); // → fix
    const round = openRecoveryRound(store, {
      ticketId: id,
      sourceStage: 'uat',
      sourceProcessId: 'gates',
      sourceStageRunId: null,
      sourceProcessRunId: null,
      triggerKind: 'gate-failure',
      triggerDetail: 'exit 2',
      maxRounds: 3,
      startedAt: T2,
    });
    expect(round.episode).toBe(2);
    expect(round.round).toBe(1);
  });

  it('preserves append-only gate evidence', () => {
    walkToUat(store, id);
    transition(store, id, 'uat', { kind: 'failed', reason: 'exit 1' });
    exhaustRound(store, id, 'uat');
    store.db
      .prepare(
        `INSERT INTO gate_runs
           (ticket_id, stage_key, attempt, run_at, gate_name, exit_code, started_at, ended_at, repo, command)
         VALUES (?, 'uat', 0, ?, 'test', 1, ?, ?, 'api', 'npm test')`,
      )
      .run(id, T0, T0, T0);
    const before = store.db
      .prepare('SELECT COUNT(*) AS n FROM gate_runs WHERE ticket_id = ?')
      .get(id) as { n: number };
    resetGateStage(store, id, { now: () => T2 });
    const after = store.db
      .prepare('SELECT COUNT(*) AS n FROM gate_runs WHERE ticket_id = ?')
      .get(id) as { n: number };
    expect(after.n).toBe(before.n);
  });

  it('refuses while a fix execution is in flight (mutates nothing)', () => {
    walkToUat(store, id);
    transition(store, id, 'uat', { kind: 'failed', reason: 'exit 1' }); // → fix
    const r = openRecoveryRound(store, {
      ticketId: id,
      sourceStage: 'uat',
      sourceProcessId: 'gates',
      sourceStageRunId: null,
      sourceProcessRunId: null,
      triggerKind: 'gate-failure',
      triggerDetail: 'exit 1',
      maxRounds: 3,
      startedAt: T0,
    });
    beginLiveFixExecution(store, { ticketId: id, roundId: r.id, startedAt: T1 });
    expect(() => resetGateStage(store, id)).toThrow(/in-flight/);
    expect(getTicket(store, id).stageCurrent).toBe('fix');
  });

  it('refuses when no gate stage is failed', () => {
    expect(() => resetGateStage(store, id)).toThrow(/not recoverable/);
  });
});