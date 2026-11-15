import { describe, it, expect, beforeEach } from 'vitest';
import { openStore, type Store } from './db.js';
import { createTicketFlow } from '../workflow/stages/create.js';
import { upsertProject } from './projects.js';
import { openRecoveryRound } from './recoveryRounds.js';
import { claimHostRerun, claimHostRerunRequest, hostRerunSpent } from './hostRerunRound.js';

const AT = '2026-01-01T00:00:00Z';

describe('hostRerunSpent', () => {
  let store: Store;
  let ticketId: number;
  let roundId: number;

  beforeEach(() => {
    store = openStore(':memory:');
    const projectId = upsertProject(store, { slug: 'p' }).id;
    ticketId = createTicketFlow(store, { key: 'T-1', title: 't', projectId }).id;
    roundId = openRecoveryRound(store, {
      ticketId, sourceStage: 'uat', sourceProcessId: 'gates', triggerKind: 'gate-failure',
      triggerDetail: 'x', maxRounds: 3, startedAt: AT,
    } as never).id;
  });

  it('is false while the host re-run is free', () => {
    expect(hostRerunSpent(store, ticketId, 'uat')).toBe(false);
  });

  it('is true once the re-run ran', () => {
    claimHostRerun(store, roundId, AT);
    expect(hostRerunSpent(store, ticketId, 'uat')).toBe(true);
    expect(hostRerunSpent(store, ticketId, 'review')).toBe(false);
  });

  it('is true once the re-run is requested', () => {
    claimHostRerunRequest(store, roundId, AT);
    expect(hostRerunSpent(store, ticketId, 'uat')).toBe(true);
  });
});
