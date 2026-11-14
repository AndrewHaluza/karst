import { describe, it, expect, beforeEach } from 'vitest';
import { openStore, type Store } from './db.js';
import { createTicketFlow } from '../workflow/stages/create.js';
import { upsertProject } from './projects.js';
import { openRecoveryRound } from './recoveryRounds.js';
import { claimHostRerun, parkRoundOutOfFixing } from './hostRerunRound.js';
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
    claimHostRerun(store, roundId, AT);
    expect(getTicket(store, ticketId).hostRerunning).toBe(true);
  });

  it('is false once the round left fixing', () => {
    claimHostRerun(store, roundId, AT);
    parkRoundOutOfFixing(store, roundId, 'parked', AT);
    expect(getTicket(store, ticketId).hostRerunning).toBe(false);
  });
});
