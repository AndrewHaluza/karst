import { beforeEach, describe, expect, it } from 'vitest';
import { openStore, type Store } from './db.js';
import { createTicketFlow } from '../workflow/stages/create.js';
import { openRecoveryRound } from './recoveryRounds.js';
import { upsertProject } from './projects.js';
import { listFixRoundAcceptances, recordFixRoundAcceptance } from './fixRoundAcceptances.js';

const AT = '2026-01-01T00:00:00Z';

describe('fix round acceptances', () => {
  let store: Store;
  let ticketId: number;
  let roundId: number;
  beforeEach(() => {
    store = openStore(':memory:');
    ticketId = createTicketFlow(store, { key: 'T-1', title: 't', projectId: upsertProject(store, { slug: 'p' }).id }).id;
    roundId = openRecoveryRound(store, {
      ticketId, sourceStage: 'review', sourceProcessId: 'review', triggerKind: 'blocking-review-findings',
      triggerDetail: 'x', maxRounds: 3, startedAt: AT,
    } as never).id;
  });

  it('writes and lists an acceptance with items and note', () => {
    const id = recordFixRoundAcceptance(store, { ticketId, roundId, sourceStage: 'review', triggerKind: 'blocking-review-findings', items: ['[high] a (x.ts:3)'], note: 'known', decidedAt: AT });
    expect(listFixRoundAcceptances(store, ticketId)).toEqual([
      { id, ticketId, roundId, sourceStage: 'review', triggerKind: 'blocking-review-findings', items: ['[high] a (x.ts:3)'], note: 'known', decidedAt: AT },
    ]);
  });
  it('stores a blank note as null', () => {
    recordFixRoundAcceptance(store, { ticketId, roundId, sourceStage: 'review', triggerKind: 'blocking-review-findings', items: [], note: '  ', decidedAt: AT });
    expect(listFixRoundAcceptances(store, ticketId)[0]?.note).toBeNull();
  });
});
