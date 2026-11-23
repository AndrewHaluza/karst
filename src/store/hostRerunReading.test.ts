import { describe, it, expect, beforeEach } from 'vitest';
import { openStore, type Store } from './db.js';
import { createTicketFlow } from '../workflow/stages/create.js';
import { upsertProject } from './projects.js';
import { openRecoveryRound } from './recoveryRounds.js';
import { claimNoChangeRerun } from './fixNoChangeRounds.js';
import { claimHostRerun, markHostRerunFailed, parkRoundOutOfFixing, readHostRerunning, HOST_RERUN_READING_MAX_MS } from './hostRerunRound.js';
import { getTicket, setStageCurrent } from './tickets.js';
import { completeFixExecution, interruptFixExecution, reopenInterruptedRound } from './recoveryRounds.js';
import { reconcileOnStart } from '../recovery/reconcile.js';

const AT = '2026-01-01T00:00:00Z';

describe('the derived hostRerunning reading of a loaded ticket', () => {
  let store: Store;
  let ticketId: number;
  let roundId: number;

  beforeEach(() => {
    store = openStore(':memory:');
    const projectId = upsertProject(store, { slug: 'p' }).id;
    ticketId = createTicketFlow(store, { key: 'T-1', title: 't', projectId }).id;
    roundId = openRecoveryRound(store, {
      ticketId,
      sourceStage: 'uat',
      sourceProcessId: 'gates',
      triggerKind: 'gate-failure',
      triggerDetail: 'x',
      maxRounds: 3,
      startedAt: AT,
    } as never).id;
    setStageCurrent(store, ticketId, 'fix');
    store.db.prepare("UPDATE recovery_rounds SET status = 'fixing' WHERE id = ?").run(roundId);
  });

  it('is false before the host claims the re-run', () => {
    expect(getTicket(store, ticketId).hostRerunning).toBe(false);
  });

  it('is true while the active fixing round holds a claimed re-run', () => {
    claimHostRerun(store, roundId, new Date().toISOString());
    expect(getTicket(store, ticketId).hostRerunning).toBe(true);
  });

  it('is false once the round left fixing', () => {
    claimHostRerun(store, roundId, AT);
    parkRoundOutOfFixing(store, roundId, 'parked', AT);
    expect(getTicket(store, ticketId).hostRerunning).toBe(false);
  });

  it('is false once the re-run ended failed and left the round fixing', () => {
    claimHostRerun(store, roundId, AT);
    markHostRerunFailed(store, roundId, 'the host re-run failed');
    expect(getTicket(store, ticketId).hostRerunning).toBe(false);
  });

  it('is false when the claim is older than the longest re-run (the host died)', () => {
    const old = new Date(Date.now() - HOST_RERUN_READING_MAX_MS - 60_000).toISOString();
    claimHostRerun(store, roundId, old);
    expect(getTicket(store, ticketId).hostRerunning).toBe(false);
  });

  it('is true for a fresh claim', () => {
    claimHostRerun(store, roundId, new Date().toISOString());
    expect(getTicket(store, ticketId).hostRerunning).toBe(true);
  });

  it('a host restart ends the reading of a claim whose owner is dead', () => {
    claimHostRerun(store, roundId, new Date().toISOString(), 424242);
    reconcileOnStart(store, (pid) => pid !== 424242);
    expect(readHostRerunning(store, ticketId)).toBe(false);
    const row = store.db.prepare('SELECT status, end_reason AS r FROM recovery_rounds WHERE id = ?').get(roundId) as { status: string; r: string };
    expect(row.status).toBe('fixing');
    expect(row.r).toMatch(/restart/);
  });

  it('a boot in another window leaves a claim whose owner is alive', () => {
    claimHostRerun(store, roundId, new Date().toISOString(), 424242);
    reconcileOnStart(store, () => true);
    expect(readHostRerunning(store, ticketId)).toBe(true);
  });

  it('a claim with no recorded owner is treated as dead', () => {
    store.db.prepare('UPDATE recovery_rounds SET host_rerun_at = ? WHERE id = ?').run(new Date().toISOString(), roundId);
    reconcileOnStart(store, () => true);
    expect(readHostRerunning(store, ticketId)).toBe(false);
  });

  it('a no-change re-run claim reads in flight, and a restart ends it when its owner is dead', () => {
    store.db.prepare("UPDATE recovery_rounds SET no_change_reason = 'r' WHERE id = ?").run(roundId);
    claimNoChangeRerun(store, roundId, new Date().toISOString(), 424242);
    expect(readHostRerunning(store, ticketId)).toBe(true);
    reconcileOnStart(store, (pid) => pid !== 424242);
    expect(readHostRerunning(store, ticketId)).toBe(false);
    const row = store.db.prepare('SELECT end_reason AS r FROM recovery_rounds WHERE id = ?').get(roundId) as { r: string };
    expect(row.r).toMatch(/restart/);
  });

  it('an interrupt of a claimed no-change re-run gives it a reason', () => {
    store.db.prepare("UPDATE recovery_rounds SET no_change_reason = 'r' WHERE id = ?").run(roundId);
    claimNoChangeRerun(store, roundId, new Date().toISOString());
    interruptFixExecution(store, roundId, AT);
    const row = store.db.prepare('SELECT end_reason AS r FROM recovery_rounds WHERE id = ?').get(roundId) as { r: string | null };
    expect(row.r).not.toBeNull();
  });

  it('the claim records the owner pid', () => {
    claimHostRerun(store, roundId, AT, 777);
    expect(store.db.prepare('SELECT host_rerun_pid AS p FROM recovery_rounds WHERE id = ?').get(roundId)).toEqual({ p: 777 });
  });

  it('a restart leaves a round with no claim alone', () => {
    reconcileOnStart(store, () => false);
    const row = store.db.prepare('SELECT end_reason AS r FROM recovery_rounds WHERE id = ?').get(roundId) as { r: string | null };
    expect(row.r).toBeNull();
  });

  it('the failure reason does not outlive the open round (revalidating)', () => {
    claimHostRerun(store, roundId, new Date().toISOString());
    markHostRerunFailed(store, roundId, 'the host re-run failed');
    completeFixExecution(store, ticketId, AT);
    const row = store.db.prepare('SELECT status, end_reason AS r FROM recovery_rounds WHERE id = ?').get(roundId) as { status: string; r: string | null };
    expect(row).toEqual({ status: 'revalidating', r: null });
  });

  it('an interrupt keeps the failure reason as history', () => {
    claimHostRerun(store, roundId, new Date().toISOString());
    markHostRerunFailed(store, roundId, 'the host re-run failed');
    interruptFixExecution(store, roundId, AT);
    const row = store.db.prepare('SELECT status, end_reason AS r FROM recovery_rounds WHERE id = ?').get(roundId) as { status: string; r: string | null };
    expect(row).toEqual({ status: 'interrupted', r: 'the host re-run failed' });
  });

  it('an interrupt of a claimed re-run with no result gives it a reason, so a reopened round does not read in flight', () => {
    claimHostRerun(store, roundId, new Date().toISOString());
    interruptFixExecution(store, roundId, AT);
    expect(reopenInterruptedRound(store, ticketId, roundId)).toBe(true);
    store.db.prepare("UPDATE recovery_rounds SET status = 'fixing' WHERE id = ?").run(roundId);
    expect(getTicket(store, ticketId).hostRerunning).toBe(false);
  });

  it('an interrupt of a round with no claim leaves no reason', () => {
    interruptFixExecution(store, roundId, AT);
    const row = store.db.prepare('SELECT end_reason AS r FROM recovery_rounds WHERE id = ?').get(roundId) as { r: string | null };
    expect(row.r).toBeNull();
  });
});
