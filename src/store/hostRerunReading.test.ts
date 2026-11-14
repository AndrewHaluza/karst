import { describe, it, expect, beforeEach } from 'vitest';
import { openStore, type Store } from './db.js';
import { createTicketFlow } from '../workflow/stages/create.js';
import { upsertProject } from './projects.js';
import { openRecoveryRound } from './recoveryRounds.js';
import { claimHostRerun, markHostRerunFailed, parkRoundOutOfFixing, HOST_RERUN_READING_MAX_MS } from './hostRerunRound.js';
import { getTicket, setStageCurrent } from './tickets.js';

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
});
