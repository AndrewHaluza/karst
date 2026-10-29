import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { createTicket } from '../store/tickets.js';
import { recordFindings, type FindingInput } from '../store/reviewFindings.js';
import { reviewStallAttempts } from './reviewStallRead.js';

describe('reviewStallAttempts', () => {
  let store: Store;
  let ticketId: number;
  beforeEach(() => {
    store = openStore(':memory:');
    ticketId = createTicket(store, { key: 'S', title: 's' }).id;
  });
  afterEach(() => store.close());

  const f = (over: Partial<FindingInput> = {}): FindingInput => ({
    severity: 'high', repo: '/r', file: 'a.ts', title: 't', detail: 'd', source: 'agent', ...over,
  });
  const put = (attempt: number, ...findings: FindingInput[]) =>
    recordFindings(store, { ticketId, attempt, runAt: `2026-01-01T00:00:0${attempt}Z`, findings });

  it('groups blocking agent findings per attempt, oldest first', () => {
    put(0, f({ file: 'a.ts' }), f({ file: 'b.ts' }));
    put(1, f({ file: 'a.ts' }));
    const out = reviewStallAttempts(store, ticketId, 'high');
    expect(out.map((a) => a.attempt)).toEqual([0, 1]);
    expect(out[0]!.findings.map((x) => x.file)).toEqual(['a.ts', 'b.ts']);
    expect(out[1]!.findings[0]!.identity).toMatch(/^[0-9a-f]{40}$/);
  });
  it('drops findings below the blocking severity and human findings', () => {
    put(0, f({ severity: 'low' }), f({ source: 'human' }));
    put(1, f({ severity: 'critical' }));
    expect(reviewStallAttempts(store, ticketId, 'high').map((a) => a.attempt)).toEqual([1]);
  });
  it("'none' blocks nothing", () => {
    put(0, f());
    expect(reviewStallAttempts(store, ticketId, 'none')).toEqual([]);
  });
  it('only counts findings recorded after a reset round ended the episode', () => {
    put(0, f());
    put(1, f());
    store.db
      .prepare(
        `INSERT INTO recovery_rounds (ticket_id, source_stage, source_process_id, trigger_kind, trigger_detail, episode, round, max_rounds, status, started_at, ended_at)
         VALUES (?, 'review', 'review', 'blocking-review-findings', 'x', 1, 1, 3, 'reset', '2026-01-01T00:00:00Z', '2026-01-01T00:00:01Z')`,
      )
      .run(ticketId);
    expect(reviewStallAttempts(store, ticketId, 'high').map((a) => a.attempt)).toEqual([1]);
  });
});
