import { beforeEach, describe, expect, it } from 'vitest';
import { openStore, type Store } from './db.js';
import { createTicketFlow } from '../workflow/stages/create.js';
import { openRecoveryRound } from './recoveryRounds.js';
import { roundById } from './recoveryRoundsRead.js';
import { setStage } from './stages.js';
import { setStageCurrent } from './tickets.js';
import { upsertProject } from './projects.js';
import { parkRoundOutOfFixing } from './hostRerunRound.js';
import {
  claimNoChangeRerun, ticketsWithRequestedNoChangeRerun, previousNoChangeRound, parkedFixRound, recordNoChangeReason,
} from './fixNoChangeRounds.js';

const AT = '2026-01-01T00:00:00Z';

describe('no-change round store helpers', () => {
  let store: Store;
  let ticketId: number;
  let projectId: number;

  const openFixing = (triggerKind: string, sourceStage: 'uat' | 'review'): number => {
    const id = openRecoveryRound(store, {
      ticketId, sourceStage, sourceProcessId: sourceStage === 'uat' ? 'gates' : 'review', triggerKind,
      triggerDetail: 'x', maxRounds: 3, startedAt: AT,
    } as never).id;
    store.db.prepare("UPDATE recovery_rounds SET status = 'fixing' WHERE id = ?").run(id);
    return id;
  };

  beforeEach(() => {
    store = openStore(':memory:');
    projectId = upsertProject(store, { slug: 'p' }).id;
    ticketId = createTicketFlow(store, { key: 'T-1', title: 't', projectId }).id;
    setStage(store, ticketId, 'fix', { status: 'running', startedAt: AT });
    setStageCurrent(store, ticketId, 'fix');
  });

  it('records the reason once per round', () => {
    const roundId = openFixing('gate-failure', 'uat');
    expect(recordNoChangeReason(store, roundId, 'flaky port', AT)).toBe(true);
    expect(recordNoChangeReason(store, roundId, 'again', AT)).toBe(false);
    expect(roundById(store, roundId)?.noChangeReason).toBe('flaky port');
  });

  it('claims the no-change re-run once, and only with a reason', () => {
    const roundId = openFixing('gate-failure', 'uat');
    expect(claimNoChangeRerun(store, roundId, AT)).toBe(false);
    recordNoChangeReason(store, roundId, 'r', AT);
    expect(claimNoChangeRerun(store, roundId, AT)).toBe(true);
    expect(claimNoChangeRerun(store, roundId, AT)).toBe(false);
  });

  it('lists a ticket whose fixing gate-failure round has a reason and no claim', () => {
    const roundId = openFixing('gate-failure', 'uat');
    expect(ticketsWithRequestedNoChangeRerun(store, projectId)).toEqual([]);
    recordNoChangeReason(store, roundId, 'r', AT);
    expect(ticketsWithRequestedNoChangeRerun(store, projectId)).toEqual([ticketId]);
    claimNoChangeRerun(store, roundId, AT);
    expect(ticketsWithRequestedNoChangeRerun(store, projectId)).toEqual([]);
  });

  it('finds the earlier round with a reason for the same source stage', () => {
    const round1 = openFixing('blocking-review-findings', 'review');
    recordNoChangeReason(store, round1, 'r', AT);
    store.db.prepare("UPDATE recovery_rounds SET status = 'revalidating' WHERE id = ?").run(round1);
    const round2 = openRecoveryRound(store, {
      ticketId, sourceStage: 'review', sourceProcessId: 'review', triggerKind: 'blocking-review-findings',
      triggerDetail: 'x', maxRounds: 3, startedAt: AT,
    } as never).id;
    expect(previousNoChangeRound(store, ticketId, 'review', round2)?.id).toBe(round1);
    expect(previousNoChangeRound(store, ticketId, 'uat', round2)).toBeNull();
  });

  it('parkedFixRound: the latest interrupted uat or review round of a ticket parked at fix', () => {
    const roundId = openFixing('blocking-review-findings', 'review');
    expect(parkedFixRound(store, ticketId)).toBeNull();
    parkRoundOutOfFixing(store, roundId, 'parked', AT);
    setStage(store, ticketId, 'fix', { status: 'failed', verdict: 'parked', endedAt: AT });
    expect(parkedFixRound(store, ticketId)?.id).toBe(roundId);
  });

  it('parkedFixRound: null for an exhausted round, a blocked park, or a ticket not at fix', () => {
    const roundId = openFixing('blocking-review-findings', 'review');
    parkRoundOutOfFixing(store, roundId, 'parked', AT);
    setStage(store, ticketId, 'fix', { status: 'failed', verdict: 'parked', endedAt: AT });
    store.db.prepare("UPDATE recovery_rounds SET status = 'exhausted' WHERE id = ?").run(roundId);
    expect(parkedFixRound(store, ticketId)).toBeNull();
    store.db.prepare("UPDATE recovery_rounds SET status = 'interrupted' WHERE id = ?").run(roundId);
    store.db.prepare("UPDATE stages SET blocked_kind = 'review-stalled' WHERE ticket_id = ? AND stage_key = 'fix'").run(ticketId);
    expect(parkedFixRound(store, ticketId)).toBeNull();
    store.db.prepare("UPDATE stages SET blocked_kind = NULL WHERE ticket_id = ? AND stage_key = 'fix'").run(ticketId);
    setStageCurrent(store, ticketId, 'uat');
    expect(parkedFixRound(store, ticketId)).toBeNull();
  });
});
