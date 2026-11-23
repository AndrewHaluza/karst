/**
 * The replan-drain predicate (T1322): no active revision and the newest
 * revision is `draining`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../../../store/db.js';
import { inReplanDrain } from './replanDrain.js';

describe('inReplanDrain', () => {
  let store: Store;
  let ticketId: number;
  let graphRunId: number;

  beforeEach(() => {
    store = openStore(':memory:');
    ticketId = Number(store.db.prepare("INSERT INTO tickets (key) VALUES ('T-1')").run().lastInsertRowid);
    graphRunId = insertRun(0);
  });
  afterEach(() => store.close());

  function insertRun(attempt: number): number {
    return Number(
      store.db
        .prepare(
          `INSERT INTO approach_graph_runs (ticket_id, stage_key, stage_attempt, approach_id, status, created_at)
           VALUES (?, 'impl', ?, 'x', 'draining', '2026-08-12T00:00:00.000Z')`,
        )
        .run(ticketId, attempt).lastInsertRowid,
    );
  }

  function insertRevisions(runId: number, statuses: readonly string[]): void {
    statuses.forEach((status, i) => {
      store.db
        .prepare(
          `INSERT INTO approach_graph_revisions
             (graph_run_id, revision_number, canonical_graph, fingerprint, status, created_at)
           VALUES (?, ?, '{}', ?, ?, '2026-08-12T00:00:00.000Z')`,
        )
        .run(runId, i + 1, `fp-${runId}-${i}`, status);
    });
  }

  it.each([
    { statuses: ['draining'], expected: true },
    { statuses: ['superseded', 'draining'], expected: true },
    { statuses: ['active'], expected: false },
    { statuses: ['active', 'draining'], expected: false },
    { statuses: ['draining', 'active'], expected: false },
    { statuses: ['draining', 'superseded'], expected: false },
    { statuses: ['completed'], expected: false },
    { statuses: [], expected: false },
  ])('revisions $statuses (oldest first): $expected', ({ statuses, expected }) => {
    insertRevisions(graphRunId, statuses);
    expect(inReplanDrain(store.db, graphRunId)).toBe(expected);
  });

  it('reads only the revisions of the given run', () => {
    const otherRunId = insertRun(1);
    insertRevisions(graphRunId, ['draining']);
    insertRevisions(otherRunId, ['active']);
    expect(inReplanDrain(store.db, graphRunId)).toBe(true);
    expect(inReplanDrain(store.db, otherRunId)).toBe(false);
  });
});
