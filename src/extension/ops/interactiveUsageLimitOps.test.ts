import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { createTicket } from '../../store/tickets.js';
import { claimUsageLimitPark, listOpenParks } from '../../store/usageLimitParks.js';
import { recordInteractiveUsageLimit, type InteractiveSignal } from './interactiveUsageLimitOps.js';

describe('recordInteractiveUsageLimit', () => {
  let store: Store;
  let ticketId: number;
  const offer = vi.fn();
  beforeEach(() => {
    store = openStore(':memory:');
    ticketId = createTicket(store, { key: 'T-IUL', title: 'thing' }).id;
    offer.mockReset();
  });
  afterEach(() => store.close());

  const signal = (over: Partial<InteractiveSignal> = {}): InteractiveSignal => ({
    ticketId,
    sessionId: 's1',
    provider: 'claude',
    model: 'claude-sonnet-5',
    stage: 'impl',
    text: 'Claude usage limit reached',
    ...over,
  });

  it('quota text parks an interactive row and offers once', () => {
    const id = recordInteractiveUsageLimit({ store, offer }, signal());
    const rows = listOpenParks(store, ticketId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id, kind: 'interactive', lane: null, target: null, stage: 'impl', sessionId: 's1' });
    expect(offer).toHaveBeenCalledTimes(1);
  });

  it('agent prose about a rate limit does not park', () => {
    expect(recordInteractiveUsageLimit({ store, offer }, signal({ text: 'add a rate limit here' }))).toBeNull();
    expect(listOpenParks(store, ticketId)).toHaveLength(0);
    expect(offer).not.toHaveBeenCalled();
  });

  it('a repeated signal while a row is open does not duplicate or re-offer', () => {
    recordInteractiveUsageLimit({ store, offer }, signal());
    recordInteractiveUsageLimit({ store, offer }, signal());
    expect(listOpenParks(store, ticketId)).toHaveLength(1);
    expect(offer).toHaveBeenCalledTimes(1);
  });

  it('two planning sessions on one ticket keep separate rows', () => {
    recordInteractiveUsageLimit({ store, offer }, signal({ stage: null, sessionId: 's1' }));
    recordInteractiveUsageLimit({ store, offer }, signal({ stage: null, sessionId: 's2' }));
    expect(listOpenParks(store, ticketId)).toHaveLength(2);
    expect(offer).toHaveBeenCalledTimes(2);
  });

  it('the same session at a later stage is a new park and a new offer', () => {
    recordInteractiveUsageLimit({ store, offer }, signal({ stage: 'impl' }));
    recordInteractiveUsageLimit({ store, offer }, signal({ stage: 'fix' }));
    expect(listOpenParks(store, ticketId)).toHaveLength(2);
    expect(offer).toHaveBeenCalledTimes(2);
  });

  it('an open non-interactive park at the same stage does not suppress the offer', () => {
    store.db
      .prepare(
        `INSERT INTO usage_limit_parks (ticket_id, stage, kind, session_id, provider, detail, parked_at)
         VALUES (?, 'impl', 'op', 's1', 'claude', 'x', '2026-10-23T00:00:00.000Z')`,
      )
      .run(ticketId);
    recordInteractiveUsageLimit({ store, offer }, signal());
    expect(offer).toHaveBeenCalledTimes(1);
  });

  it('a resolved park re-offers on a fresh signal', () => {
    const id = recordInteractiveUsageLimit({ store, offer }, signal())!;
    claimUsageLimitPark(store, id, 'retry');
    recordInteractiveUsageLimit({ store, offer }, signal());
    expect(offer).toHaveBeenCalledTimes(2);
  });
});
