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
         VALUES (?, 'review', 'review', 'blocking-review-findings', 'x', 1, 1, 3, 'reset', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
      )
      .run(ticketId);
    expect(reviewStallAttempts(store, ticketId, 'high').map((a) => a.attempt)).toEqual([1]);
  });

  describe('review runs', () => {
    const run = (attempt: number, status: string, outcome: string | null, reviewerPassed = false, second = attempt) => {
      const { lastInsertRowid } = store.db
        .prepare(
          `INSERT INTO stage_runs (ticket_id, stage_key, attempt, run_at, status, outcome, started_at)
           VALUES (?, 'review', ?, ?, ?, ?, '2026-01-01T00:00:00Z')`,
        )
        .run(ticketId, attempt, `2026-01-01T00:00:0${second}Z`, status, outcome);
      if (reviewerPassed) {
        store.db
          .prepare(
            `INSERT INTO process_runs (ticket_id, stage_key, process_id, attempt, stage_run_id, status, started_at)
             VALUES (?, 'review', 'review', ?, ?, 'passed', '2026-01-01T00:00:00Z')`,
          )
          .run(ticketId, attempt, lastInsertRowid);
      }
    };

    it('a finished run without blocking findings is an empty attempt in order', () => {
      put(1, f());
      run(2, 'finished', 'advanced', true);
      put(3, f());
      const out = reviewStallAttempts(store, ticketId, 'high');
      expect(out.map((a) => [a.attempt, a.findings.length])).toEqual([[1, 1], [2, 0], [3, 1]]);
    });
    it('stale, blocked and stopped runs neither count nor break', () => {
      put(1, f());
      run(2, 'stale', null);
      run(3, 'finished', 'blocked');
      run(4, 'finished', 'stopped');
      expect(reviewStallAttempts(store, ticketId, 'high').map((a) => a.attempt)).toEqual([1]);
    });
    it('a finished run whose reviewer never ran (red gate) is not a clean round', () => {
      put(1, f());
      run(2, 'finished', 'advanced', false);
      expect(reviewStallAttempts(store, ticketId, 'high').map((a) => a.attempt)).toEqual([1]);
    });
    it('kept sibling findings of a blocked park count in the rerun that reaches a verdict', () => {
      put(1, f({ file: 'a.ts' }));
      run(1, 'finished', 'blocked');
      run(1, 'finished', 'advanced', true, 2);
      const out = reviewStallAttempts(store, ticketId, 'high');
      expect(out.map((a) => [a.attempt, a.findings.map((x) => x.file)])).toEqual([[1, ['a.ts']]]);
    });
    it('findings of a blocked run with no later verdict form no round', () => {
      put(1, f());
      put(2, f());
      run(2, 'finished', 'blocked');
      expect(reviewStallAttempts(store, ticketId, 'high').map((a) => a.attempt)).toEqual([1]);
    });
    it('a clean run keeps its place when a blocking run shares its attempt number', () => {
      put(1, f());
      run(1, 'finished', 'advanced', true, 2);
      recordFindings(store, { ticketId, attempt: 1, runAt: '2026-01-01T00:00:03Z', findings: [f({ file: 'b.ts' })] });
      const out = reviewStallAttempts(store, ticketId, 'high');
      expect(out.map((a) => a.findings.length)).toEqual([1, 0, 1]);
    });
    it('carries the finding line', () => {
      put(1, f({ line: 42 }));
      expect(reviewStallAttempts(store, ticketId, 'high')[0]!.findings[0]!.line).toBe(42);
    });
  });
});
