import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { createTicket, getTicket } from '../../store/tickets.js';
import { setStage } from '../../store/stages.js';
import { reconcilePrFeedback } from '../../store/prFeedback.js';
import type { PrReviewThread } from '../../model/prReview.js';
import { addressPrFeedback, type PrFeedbackActionDeps } from './prFeedbackAction.js';

const T0 = '2026-01-01T00:00:00.000Z';

function thread(upstreamKey: string): PrReviewThread {
  return {
    nodeId: `PRRT_${upstreamKey}`,
    upstreamKey,
    isResolved: false,
    isOutdated: false,
    path: 'src/app.ts',
    line: 12,
    startLine: null,
    originalLine: 10,
    originalCommitId: 'abc',
    subjectType: 'LINE',
    author: { login: 'reviewer', typeName: 'User', association: 'MEMBER' },
    body: 'please fix',
    comments: [],
    updatedAt: T0,
  };
}

describe('addressPrFeedback', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  function shipTicketWithFeedback(): number {
    const ticket = createTicket(store, { key: 'A', title: 't' });
    store.db.prepare("UPDATE tickets SET stage_current = 'ship' WHERE id = ?").run(ticket.id);
    setStage(store, ticket.id, 'ship', {
      status: 'passed',
      startedAt: T0,
      endedAt: T0,
      blockedKind: 'awaiting-merge',
      blockedReason: 'PR open',
      blockedAt: T0,
    });
    reconcilePrFeedback(store, {
      ticketId: ticket.id,
      repo: 'frontend',
      prUrl: 'https://github.com/acme/repo/pull/1',
      at: T0,
      snapshot: { decision: null, reviews: [], threads: [thread('1')] },
    });
    return ticket.id;
  }

  function deps(ticketId: number, over: Partial<PrFeedbackActionDeps> = {}) {
    const calls = {
      info: [] as string[],
      error: [] as string[],
      logError: [] as Array<{ message: string; err: unknown }>,
      debug: [] as string[],
      confirm: 0,
      drive: 0,
      afterServerChange: 0,
    };
    const value: PrFeedbackActionDeps = {
      store,
      ticketId,
      confirm: async () => {
        calls.confirm += 1;
        return true;
      },
      info: (m) => calls.info.push(m),
      error: (m) => calls.error.push(m),
      logError: (message, err) => calls.logError.push({ message, err }),
      debug: (m) => calls.debug.push(m),
      drive: () => {
        calls.drive += 1;
      },
      afterServerChange: () => {
        calls.afterServerChange += 1;
      },
      ...over,
    };
    return { value, calls };
  }

  it('informs and does not confirm when the action is unavailable', async () => {
    const ticket = createTicket(store, { key: 'A', title: 't' });
    const { value, calls } = deps(ticket.id);
    await addressPrFeedback(value);
    expect(calls.info).toHaveLength(1);
    expect(calls.confirm).toBe(0);
    expect(calls.drive).toBe(0);
    expect(calls.afterServerChange).toBe(1);
  });

  it('enters the round on confirm and reports the round and item count', async () => {
    const id = shipTicketWithFeedback();
    let detail = '';
    const { value, calls } = deps(id, {
      confirm: async (d) => {
        detail = d;
        return true;
      },
    });
    await addressPrFeedback(value);
    expect(getTicket(store, id).stageCurrent).toBe('fix');
    expect(calls.info[0]).toContain('round 1');
    expect(calls.info[0]).toContain('1 item(s)');
    expect(detail).toContain('moves the ticket to Fix');
    expect(detail).toContain('round 1 of 3');
    // The driver is kicked so the Fix session is actually launched.
    expect(calls.drive).toBe(1);
    expect(calls.afterServerChange).toBe(1);
  });

  it('mutates nothing and still refreshes when the modal is dismissed', async () => {
    const id = shipTicketWithFeedback();
    const { value, calls } = deps(id, { confirm: async () => false });
    await addressPrFeedback(value);
    expect(getTicket(store, id).stageCurrent).toBe('ship');
    expect(calls.info).toHaveLength(0);
    expect(calls.drive).toBe(0);
    expect(calls.afterServerChange).toBe(1);
  });

  it('logs and reports an error, and still refreshes, when the mutation refuses', async () => {
    const id = shipTicketWithFeedback();
    const { value, calls } = deps(id, {
      // The ticket moves between the check and the mutation: adopt the only row
      // into a terminal round so `enterPrFeedbackFix` re-derives and refuses.
      confirm: async () => {
        store.db
          .prepare(
            "UPDATE pr_feedback SET is_resolved = 1 WHERE ticket_id = ?",
          )
          .run(id);
        return true;
      },
    });
    await addressPrFeedback(value);
    expect(calls.logError).toHaveLength(1);
    expect(calls.logError[0]!.message).toContain('address pull request feedback');
    expect(calls.error).toHaveLength(1);
    expect(calls.error[0]).toContain('no-feedback');
    expect(getTicket(store, id).stageCurrent).toBe('ship');
    expect(calls.afterServerChange).toBe(1);
  });
});
