import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { createTicket, getTicket } from '../store/tickets.js';
import { setStage, getStage } from '../store/stages.js';
import { recordShippedPr, updatePrStatus } from '../store/prs.js';
import { reconcilePrFeedback } from '../store/prFeedback.js';
import { openRecoveryRound } from '../store/recoveryRounds.js';
import { enterPrFeedbackFix, prFeedbackFixState } from './prFeedbackFix.js';
import { FIX_ATTEMPT_CAP } from './fixAttempts.js';
import type {
  PrFeedbackSnapshot,
  PrReviewAuthor,
  PrReviewThread,
} from '../model/prReview.js';

const AUTHOR: PrReviewAuthor = { login: 'reviewer', typeName: 'User', association: 'MEMBER' };
const PR_URL = 'https://github.com/acme/repo/pull/1';
const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-01-02T00:00:00.000Z';

function thread(overrides: Partial<PrReviewThread> = {}): PrReviewThread {
  return {
    nodeId: 'PRRT_1',
    upstreamKey: '1',
    isResolved: false,
    isOutdated: false,
    path: 'src/app.ts',
    line: 12,
    startLine: null,
    originalLine: 10,
    originalCommitId: 'abc',
    subjectType: 'LINE',
    author: AUTHOR,
    body: 'please fix',
    comments: [],
    updatedAt: T0,
    ...overrides,
  };
}

function snap(overrides: Partial<PrFeedbackSnapshot> = {}): PrFeedbackSnapshot {
  return { decision: null, reviews: [], threads: [], ...overrides };
}

describe('pr feedback fix', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  /** A ticket parked at ship, awaiting merge. Returns its id. */
  function shipTicket(key = 'A'): number {
    const ticket = createTicket(store, { key, title: 't' });
    store.db.prepare("UPDATE tickets SET stage_current = 'ship' WHERE id = ?").run(ticket.id);
    setStage(store, ticket.id, 'ship', {
      status: 'passed',
      startedAt: T0,
      endedAt: T0,
      blockedKind: 'awaiting-merge',
      blockedReason: 'PR open',
      blockedAt: T0,
    });
    return ticket.id;
  }

  function feedback(ticketId: number, keys: string[], at = T0, repo = 'frontend'): void {
    reconcilePrFeedback(store, {
      ticketId,
      repo,
      prUrl: PR_URL,
      at,
      snapshot: snap({
        threads: keys.map((k) => thread({ upstreamKey: k, nodeId: `PRRT_${k}` })),
      }),
    });
  }

  function shipRound(ticketId: number, status: string): number {
    const round = openRecoveryRound(store, {
      ticketId,
      sourceStage: 'ship',
      sourceProcessId: 'pr-review',
      sourceStageRunId: null,
      sourceProcessRunId: null,
      triggerKind: 'upstream-changes-requested',
      triggerDetail: 'x',
      maxRounds: FIX_ATTEMPT_CAP,
      startedAt: T0,
    });
    store.db
      .prepare("UPDATE recovery_rounds SET status = ?, ended_at = ? WHERE id = ?")
      .run(status, T0, round.id);
    return round.id;
  }

  function snapshot(ticketId: number) {
    return {
      stageCurrent: getTicket(store, ticketId).stageCurrent,
      stages: store.db
        .prepare('SELECT * FROM stages WHERE ticket_id = ? ORDER BY stage_key')
        .all(ticketId),
      rounds: store.db
        .prepare('SELECT * FROM recovery_rounds WHERE ticket_id = ? ORDER BY id')
        .all(ticketId),
    };
  }

  function expectRefusal(ticketId: number, reason: string): void {
    expect(prFeedbackFixState(store, ticketId)).toEqual({ available: false, reason });
    const before = snapshot(ticketId);
    expect(() => enterPrFeedbackFix(store, ticketId)).toThrow(reason);
    expect(snapshot(ticketId)).toEqual(before);
  }

  describe('availability', () => {
    it('refuses a ticket that is not parked at ship', () => {
      const ticket = createTicket(store, { key: 'A', title: 't' });
      store.db.prepare("UPDATE tickets SET stage_current = 'impl' WHERE id = ?").run(ticket.id);
      expectRefusal(ticket.id, 'stage');
    });

    it('refuses a ticket at uat/review even though send-back would offer', () => {
      const ticket = createTicket(store, { key: 'A', title: 't' });
      store.db.prepare("UPDATE tickets SET stage_current = 'review' WHERE id = ?").run(ticket.id);
      expectRefusal(ticket.id, 'stage');
    });

    it('refuses while the ship saga is in flight', () => {
      const id = shipTicket();
      setStage(store, id, 'ship', { status: 'running' });
      expectRefusal(id, 'in-flight');
    });

    it('refuses once any current PR has landed', () => {
      const id = shipTicket();
      feedback(id, ['1']);
      recordShippedPr(store, { ticketId: id, repo: 'frontend', number: 1, url: PR_URL });
      updatePrStatus(store, { ticketId: id, repo: 'frontend', url: PR_URL, status: 'merged' });
      expectRefusal(id, 'landed');
    });

    it('refuses while a ship-sourced round is already active', () => {
      const id = shipTicket();
      feedback(id, ['1']);
      shipRound(id, 'pending');
      expectRefusal(id, 'round-active');
    });

    it('refuses when there is no unadopted feedback', () => {
      const id = shipTicket();
      expectRefusal(id, 'no-feedback');
    });

    it('refuses when feedback exists but every row is outdated, resolved or adopted', () => {
      const id = shipTicket();
      feedback(id, ['1', '2', '3']);
      store.db.prepare("UPDATE pr_feedback SET is_outdated = 1 WHERE upstream_key = '2'").run();
      store.db.prepare("UPDATE pr_feedback SET is_resolved = 1 WHERE upstream_key = '3'").run();
      // Adopt row 1 into a terminal round so it no longer counts as new work.
      const roundId = shipRound(id, 'passed');
      store.db
        .prepare("UPDATE pr_feedback SET recovery_round_id = ? WHERE upstream_key = '1'")
        .run(roundId);
      expectRefusal(id, 'no-feedback');
    });

    it('refuses a fourth attempt at the cap', () => {
      const id = shipTicket();
      feedback(id, ['1']);
      shipRound(id, 'failed');
      shipRound(id, 'failed');
      shipRound(id, 'failed');
      expectRefusal(id, 'exhausted');
    });

    // The driver exhausts a round at `round >= maxRounds` (`roundFixDecision`),
    // so offering a round AT the cap would bury the feedback: the modal would
    // confirm, the ticket would move to fix, and the next drive would exhaust the
    // round without ever launching an agent. The next round is offered only while
    // the driver would actually resume it.
    it('refuses at the cap rather than offering a round the driver would immediately exhaust', () => {
      const id = shipTicket();
      feedback(id, ['1']);
      shipRound(id, 'failed');
      shipRound(id, 'failed');
      expectRefusal(id, 'exhausted');
    });
  });

  describe('enterPrFeedbackFix', () => {
    it('marks ship failed, opens a ship-sourced round and enters fix', () => {
      const id = shipTicket();
      feedback(id, ['1', '2']);

      expect(prFeedbackFixState(store, id)).toEqual({ available: true, round: 1, items: 2 });

      const result = enterPrFeedbackFix(store, id, { now: () => T1 });
      expect(result).toEqual({ roundId: expect.any(Number), round: 1, items: 2 });

      expect(getTicket(store, id).stageCurrent).toBe('fix');
      expect(getStage(store, id, 'fix')).toMatchObject({ status: 'running', attempt: 0 });
      expect(getStage(store, id, 'ship')).toMatchObject({
        status: 'failed',
        verdict: 'the review team requested changes on 2 open item(s)',
        // The round number rides as the attempt so the rail's retry meter draws.
        attempt: 1,
        endedAt: T1,
      });

      const round = store.db
        .prepare('SELECT * FROM recovery_rounds WHERE ticket_id = ?')
        .get(id) as Record<string, unknown>;
      expect(round).toMatchObject({
        source_stage: 'ship',
        source_process_id: 'pr-review',
        trigger_kind: 'upstream-changes-requested',
        round: 1,
        max_rounds: FIX_ATTEMPT_CAP,
        status: 'pending',
      });
      expect(round.trigger_detail).toEqual(expect.stringContaining('frontend'));

      // Both feedback rows are now owned by the round.
      const adopted = store.db
        .prepare('SELECT recovery_round_id FROM pr_feedback WHERE ticket_id = ? ORDER BY id')
        .all(id) as Array<{ recovery_round_id: number }>;
      expect(adopted).toEqual([
        { recovery_round_id: result.roundId },
        { recovery_round_id: result.roundId },
      ]);
      expect(prFeedbackFixState(store, id)).toEqual({ available: false, reason: 'stage' });
    });

    it('leaves uat and review rows and the append-only evidence untouched', () => {
      const id = shipTicket();
      feedback(id, ['1']);
      const uatBefore = getStage(store, id, 'uat');
      const reviewBefore = getStage(store, id, 'review');
      enterPrFeedbackFix(store, id);
      expect(getStage(store, id, 'uat')).toEqual(uatBefore);
      expect(getStage(store, id, 'review')).toEqual(reviewBefore);
    });

    it('opens a second round after the first closes, adopting only new feedback', () => {
      const id = shipTicket();
      feedback(id, ['1']);
      const first = enterPrFeedbackFix(store, id);
      // The round's fix did not take: it closes (same episode) and the ticket
      // comes back to ship with the first item already adopted.
      store.db
        .prepare("UPDATE recovery_rounds SET status = 'failed', ended_at = ? WHERE id = ?")
        .run(T1, first.roundId);
      store.db.prepare("UPDATE tickets SET stage_current = 'ship' WHERE id = ?").run(id);

      // A second item arrives; the first is still present upstream.
      feedback(id, ['1', '2'], T1);

      expect(prFeedbackFixState(store, id)).toEqual({ available: true, round: 2, items: 1 });
      const second = enterPrFeedbackFix(store, id);
      expect(second.round).toBe(2);
      expect(second.items).toBe(1);

      const owners = store.db
        .prepare('SELECT upstream_key, recovery_round_id FROM pr_feedback ORDER BY upstream_key')
        .all() as Array<{ upstream_key: string; recovery_round_id: number }>;
      expect(owners).toEqual([
        { upstream_key: '1', recovery_round_id: first.roundId },
        { upstream_key: '2', recovery_round_id: second.roundId },
      ]);
    });

    // The check/mutation disagreement revision 1 shipped: `prFeedbackFixState`
    // promised a round number the open path did not assign.
    it('agrees with the round openRecoveryRound actually assigns', () => {
      const id = shipTicket();
      feedback(id, ['1']);
      shipRound(id, 'failed');

      const state = prFeedbackFixState(store, id);
      expect(state).toEqual({ available: true, round: 2, items: 1 });
      const result = enterPrFeedbackFix(store, id);
      expect(result.round).toBe(2);
    });
  });
});
