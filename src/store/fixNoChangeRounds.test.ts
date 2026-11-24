import { beforeEach, describe, expect, it } from 'vitest';
import { openStore, type Store } from './db.js';
import { createTicketFlow } from '../workflow/stages/create.js';
import { openRecoveryRound, continueFixRound } from './recoveryRounds.js';
import { roundById } from './recoveryRoundsRead.js';
import { setStage } from './stages.js';
import { setStageCurrent } from './tickets.js';
import { upsertProject } from './projects.js';
import { parkRoundOutOfFixing } from './hostRerunRound.js';
import { recordFixRoundHeads as recordHeads } from './fixRoundHeads.js';
import { FIX_CONTINUED_PREFIX } from '../model/noChange.js';
import {
  claimNoChangeRerun, requestNoChangeRerun, ticketsWithRequestedNoChangeRerun, previousNoChangeRound, parkedFixRound, recordNoChangeReason,
  sameHeadStreak, previousContinuedRound,
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

  it('lists a ticket whose fixing gate-failure round has a host request and no claim', () => {
    const roundId = openFixing('gate-failure', 'uat');
    expect(ticketsWithRequestedNoChangeRerun(store, projectId)).toEqual([]);
    recordNoChangeReason(store, roundId, 'r', AT);
    requestNoChangeRerun(store, roundId, AT);
    expect(ticketsWithRequestedNoChangeRerun(store, projectId)).toEqual([ticketId]);
    claimNoChangeRerun(store, roundId, AT);
    expect(ticketsWithRequestedNoChangeRerun(store, projectId)).toEqual([]);
  });

  it('does not list a bridge-path round: it has a reason but no host request', () => {
    const roundId = openFixing('gate-failure', 'uat');
    recordNoChangeReason(store, roundId, 'r', AT);
    expect(ticketsWithRequestedNoChangeRerun(store, projectId)).toEqual([]);
  });

  it('records the no-change claim owner pid in the shared pid column', () => {
    const roundId = openFixing('gate-failure', 'uat');
    recordNoChangeReason(store, roundId, 'r', AT);
    claimNoChangeRerun(store, roundId, AT, 555);
    expect(store.db.prepare('SELECT host_rerun_pid AS p FROM recovery_rounds WHERE id = ?').get(roundId)).toEqual({ p: 555 });
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

describe('sameHeadStreak (T1330)', () => {
  let store: Store;
  let ticketId: number;
  let projectId: number;
  const at = '2026-09-01T10:00:00.000Z';
  const heads = (sha: string) => [{ worktreePath: '/wt/web', headSha: sha }];

  const open = (triggerKind = 'gate-failure', sourceStage: 'uat' | 'review' = 'uat'): number =>
    openRecoveryRound(store, {
      ticketId, sourceStage, sourceProcessId: sourceStage === 'uat' ? 'gates' : 'review', triggerKind,
      triggerDetail: 'x', maxRounds: 10, startedAt: at,
    } as never).id;

  const set = (id: number, status: string): void => {
    store.db.prepare('UPDATE recovery_rounds SET status = ? WHERE id = ?').run(status, id);
  };

  beforeEach(() => {
    store = openStore(':memory:');
    projectId = upsertProject(store, { slug: 'p' }).id;
    ticketId = createTicketFlow(store, { key: 'T-1', title: 't', projectId }).id;
    setStage(store, ticketId, 'fix', { status: 'running', startedAt: at });
    setStageCurrent(store, ticketId, 'fix');
  });

  it('counts the round and every earlier failed gate-failure round on the same head', () => {
    const r1 = open();
    recordHeads(store, r1, heads('aaa'));
    set(r1, 'failed');
    const r2 = open();
    recordHeads(store, r2, heads('aaa'));
    set(r2, 'failed');
    const r3 = open();
    recordHeads(store, r3, heads('aaa'));
    expect(sameHeadStreak(store, roundById(store, r3)!)).toBe(3);
  });

  it('a commit between rounds restarts the count', () => {
    const r1 = open();
    recordHeads(store, r1, heads('aaa'));
    set(r1, 'failed');
    const r2 = open();
    recordHeads(store, r2, heads('bbb'));
    expect(sameHeadStreak(store, roundById(store, r2)!)).toBe(1);
  });

  it('a user Retry (an interrupted round) restarts the count', () => {
    const r1 = open();
    recordHeads(store, r1, heads('aaa'));
    set(r1, 'interrupted');
    const r2 = open();
    recordHeads(store, r2, heads('aaa'));
    set(r2, 'failed');
    const r3 = open();
    recordHeads(store, r3, heads('aaa'));
    // r1 is interrupted, so only r3 and r2 count.
    expect(sameHeadStreak(store, roundById(store, r3)!)).toBe(2);
  });

  it('stops at a round of another trigger kind', () => {
    const r1 = open('blocking-review-findings', 'review');
    set(r1, 'failed');
    const r2 = open();
    recordHeads(store, r2, heads('aaa'));
    expect(sameHeadStreak(store, roundById(store, r2)!)).toBe(1);
  });

  it('a round with no recorded heads counts as one', () => {
    const r1 = open();
    recordHeads(store, r1, heads('aaa'));
    set(r1, 'failed');
    const r2 = open();
    expect(sameHeadStreak(store, roundById(store, r2)!)).toBe(1);
  });
});

describe('previousContinuedRound (T1330)', () => {
  let store: Store;
  let ticketId: number;
  let projectId: number;
  const at = '2026-09-01T10:00:00.000Z';

  const openFixing = (sourceStage: 'uat' | 'review' = 'uat'): number => {
    const id = openRecoveryRound(store, {
      ticketId, sourceStage, sourceProcessId: sourceStage === 'uat' ? 'gates' : 'review', triggerKind: 'gate-failure',
      triggerDetail: 'x', maxRounds: 5, startedAt: at,
    } as never).id;
    store.db.prepare("UPDATE recovery_rounds SET status = 'fixing' WHERE id = ?").run(id);
    recordHeads(store, id, [{ worktreePath: '/wt/web', headSha: 'aaa' }]);
    return id;
  };

  beforeEach(() => {
    store = openStore(':memory:');
    projectId = upsertProject(store, { slug: 'pc' }).id;
    ticketId = createTicketFlow(store, { key: 'T-1', title: 't', projectId }).id;
    setStage(store, ticketId, 'fix', { status: 'running', startedAt: at });
    setStageCurrent(store, ticketId, 'fix');
  });

  it('returns the round just before the active one when the host continued it', () => {
    const r1 = openFixing();
    continueFixRound(store, { roundId: r1, endReason: `${FIX_CONTINUED_PREFIX} unit (web)`, at });
    const previous = previousContinuedRound(store, ticketId);
    expect(previous?.round.id).toBe(r1);
    expect(previous?.round.maxRounds).toBe(5);
    expect(previous?.reason).toBeNull();
  });

  it('carries the agent reason of a no-change round, never the end_reason', () => {
    const r1 = openFixing();
    recordNoChangeReason(store, r1, 'the gate is flaky on this machine', at);
    continueFixRound(store, { roundId: r1, endReason: `${FIX_CONTINUED_PREFIX} unit (web)`, at });
    expect(previousContinuedRound(store, ticketId)?.reason).toBe('the gate is flaky on this machine');
  });

  it('is null for a previous round closed for another cause', () => {
    const r1 = openFixing();
    continueFixRound(store, { roundId: r1, endReason: 'no change: port', at });
    expect(previousContinuedRound(store, ticketId)).toBeNull();
  });

  it('is null when there is no active fix round or no earlier round', () => {
    expect(previousContinuedRound(store, ticketId)).toBeNull();
    openFixing(); // round 1, active
    expect(previousContinuedRound(store, ticketId)).toBeNull();
  });
});
