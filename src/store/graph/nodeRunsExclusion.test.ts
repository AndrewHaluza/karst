/**
 * `countNodeRunsInStatusesExcludingOutcome`: the optional blocked-category
 * exclusion must not change the default count (a blocked row with a NULL
 * failure category still counts).
 */

import { describe, it, expect } from 'vitest';
import { openStore } from '../db.js';
import { createTicket } from '../tickets.js';
import { createGraphRun } from './graphRuns.js';
import { countNodeRunsInStatusesExcludingOutcome } from './nodeRuns.js';

const NOW = '2026-11-15T00:00:00.000Z';

function fixture() {
  const store = openStore(':memory:');
  const ticketId = createTicket(store, { key: 'NR-1', title: 't' }).id;
  const runId = createGraphRun(store.db, { ticketId, stageAttempt: 0, approachId: 'x', now: NOW });
  store.db.pragma('foreign_keys = OFF');
  const add = (nodeId: string, category: string | null): void => {
    store.db
      .prepare(
        `INSERT INTO approach_node_runs
           (graph_run_id, revision_id, node_id, node_kind, visit_number, status, failure_category)
         VALUES (?, 1, ?, 'agent', 1, 'blocked', ?)`,
      )
      .run(runId, nodeId, category);
  };
  add('plain', null);
  add('claim', 'resource-claim-violated');
  return { db: store.db, runId };
}

describe('countNodeRunsInStatusesExcludingOutcome', () => {
  it('counts every blocked row by default, including one with no failure category', () => {
    const { db, runId } = fixture();
    expect(countNodeRunsInStatusesExcludingOutcome(db, runId, ['blocked'], 'replan')).toBe(2);
  });

  it('skips only the blocked rows of the named failure category', () => {
    const { db, runId } = fixture();
    expect(
      countNodeRunsInStatusesExcludingOutcome(db, runId, ['blocked'], 'replan', {
        blockedCategory: 'resource-claim-violated',
      }),
    ).toBe(1);
  });
});
