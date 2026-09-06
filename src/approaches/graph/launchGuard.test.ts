/**
 * H3 — the launch guard's predicate. The bug it pins: the guard refused a new
 * graph launch when ANY graph run row existed for the ticket, in ANY status,
 * and told the user "the coordinator owns continuation" — which is false for a
 * `closed`/`cancelled`/`stale` run, because nothing owns a terminal run. A
 * ticket whose previous attempt's run was cancelled (it left impl) or closed
 * (uat failed it back) could never start a graph again.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { createTicket } from '../../store/tickets.js';
import { createGraphRun } from '../../store/graph/graphRuns.js';
import { graphLaunchDecision } from './launchGuard.js';

const NOW = '2026-09-06T00:00:00.000Z';

let store: Store;
let ticketId: number;

beforeEach(() => {
  store = openStore(':memory:');
  ticketId = createTicket(store, { key: 'T-1', title: 'graph ticket' }).id;
});

function run(status: string, stageAttempt: number): number {
  const id = createGraphRun(store.db, {
    ticketId,
    stageAttempt,
    approachId: 'karst-graph-engineering',
    now: NOW,
  });
  store.db.prepare('UPDATE approach_graph_runs SET status = ? WHERE id = ?').run(status, id);
  return id;
}

describe('graphLaunchDecision', () => {
  it('launches when the ticket has no graph run at all', () => {
    expect(graphLaunchDecision(store.db, ticketId, 0)).toEqual({ kind: 'launch' });
  });

  it.each(['planning', 'awaiting-confirmation', 'running', 'draining', 'blocked', 'completed-awaiting-impl-marker'])(
    'defers to the coordinator while a %s run exists',
    (status) => {
      const graphRunId = run(status, 0);
      expect(graphLaunchDecision(store.db, ticketId, 0)).toEqual({
        kind: 'owned',
        graphRunId,
        status,
      });
    },
  );

  it.each(['closed', 'cancelled', 'stale'])(
    'H3: a terminal (%s) run at an OLDER attempt never blocks the next attempt',
    (status) => {
      run(status, 0);
      expect(graphLaunchDecision(store.db, ticketId, 1)).toEqual({ kind: 'launch' });
    },
  );

  it('H3: a terminal run at the CURRENT attempt names the attempt, never a false ownership claim', () => {
    const graphRunId = run('cancelled', 2);
    // `UNIQUE (ticket_id, stage_attempt)` admits one graph run per impl
    // attempt, and `karst node` rejects a completion whose run attempt is not
    // the ticket's current one — so this attempt genuinely cannot host another
    // run. The answer must SAY that instead of blaming the coordinator.
    expect(graphLaunchDecision(store.db, ticketId, 2)).toEqual({
      kind: 'attempt-consumed',
      graphRunId,
      status: 'cancelled',
      stageAttempt: 2,
    });
  });

  it('a non-terminal run wins over a terminal one at the current attempt', () => {
    run('cancelled', 0);
    const live = run('running', 1);
    expect(graphLaunchDecision(store.db, ticketId, 1)).toEqual({
      kind: 'owned',
      graphRunId: live,
      status: 'running',
    });
  });

  it('another ticket’s runs are never consulted', () => {
    const other = createTicket(store, { key: 'T-2', title: 'other' }).id;
    createGraphRun(store.db, {
      ticketId: other,
      stageAttempt: 0,
      approachId: 'karst-graph-engineering',
      now: NOW,
    });
    expect(graphLaunchDecision(store.db, ticketId, 0)).toEqual({ kind: 'launch' });
  });
});
