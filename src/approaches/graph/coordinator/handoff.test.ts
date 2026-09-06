/**
 * Graph → stage-driver handoff tests.
 *
 * A graph ticket whose run has left every active status and whose impl marker
 * has advanced it to a deterministic gate is nobody's: the coordinator sweep
 * only ticks ACTIVE runs, and the stage driver is only kicked by a hook, a
 * session close, an unpause or an activation — none of which a headless graph
 * node fires. These are the reads that select such a ticket so the sweep can
 * hand it back to the driver.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../../../store/db.js';
import { ticketsAwaitingGraphDrive } from './handoff.js';

let store: Store;

const PROJECT = 1;
const NOW = '2026-09-06T22:38:22.000Z';

function insertProject(): void {
  store.db
    .prepare("INSERT INTO projects (id, slug, name, root_path) VALUES (?, 'p', 'p', '/tmp/p')")
    .run(PROJECT);
}

function insertTicket(
  id: number,
  fields: {
    stage?: string;
    projectId?: number | null;
    pausedAt?: string | null;
    approach?: string | null;
  } = {},
): void {
  store.db
    .prepare(
      `INSERT INTO tickets (id, key, title, stage_current, project_id, paused_at, approach)
       VALUES (?, ?, 't', ?, ?, ?, ?)`,
    )
    .run(
      id,
      `T-${id}`,
      fields.stage ?? 'uat',
      fields.projectId === undefined ? PROJECT : fields.projectId,
      fields.pausedAt ?? null,
      fields.approach === undefined ? 'karst-graph-engineering' : fields.approach,
    );
}

function insertStage(ticketId: number, stageKey: string, blockedKind: string | null = null): void {
  store.db
    .prepare(
      `INSERT INTO stages (ticket_id, stage_key, status, attempt, blocked_kind)
       VALUES (?, ?, 'running', 0, ?)`,
    )
    .run(ticketId, stageKey, blockedKind);
}

function insertGraphRun(id: number, ticketId: number, status: string, attempt = 0): void {
  store.db
    .prepare(
      `INSERT INTO approach_graph_runs
         (id, ticket_id, stage_key, stage_attempt, approach_id, status, created_at, updated_at)
       VALUES (?, ?, 'impl', ?, 'karst-graph-engineering', ?, ?, ?)`,
    )
    .run(id, ticketId, attempt, status, NOW, NOW);
}

beforeEach(() => {
  store = openStore(':memory:');
  insertProject();
});

afterEach(() => {
  store.db.close();
});

describe('ticketsAwaitingGraphDrive', () => {
  it('selects a graph ticket parked at uat whose run is closed', () => {
    insertTicket(1);
    insertStage(1, 'uat');
    insertGraphRun(10, 1, 'closed');
    expect(ticketsAwaitingGraphDrive(store.db, { projectId: PROJECT })).toEqual([1]);
  });

  it('selects a graph ticket parked at review', () => {
    insertTicket(1, { stage: 'review' });
    insertStage(1, 'review');
    insertGraphRun(10, 1, 'closed');
    expect(ticketsAwaitingGraphDrive(store.db, { projectId: PROJECT })).toEqual([1]);
  });

  it('leaves a ticket whose graph run is still active to the coordinator', () => {
    insertTicket(1);
    insertStage(1, 'uat');
    insertGraphRun(10, 1, 'running');
    expect(ticketsAwaitingGraphDrive(store.db, { projectId: PROJECT })).toEqual([]);
  });

  it('leaves a ticket whose newest run is active even when an older one closed', () => {
    insertTicket(1);
    insertStage(1, 'uat');
    insertGraphRun(10, 1, 'closed');
    insertGraphRun(11, 1, 'running', 1);
    expect(ticketsAwaitingGraphDrive(store.db, { projectId: PROJECT })).toEqual([]);
  });

  it('skips a ticket that is not at a deterministic gate', () => {
    insertTicket(1, { stage: 'impl' });
    insertStage(1, 'impl');
    insertGraphRun(10, 1, 'closed');
    expect(ticketsAwaitingGraphDrive(store.db, { projectId: PROJECT })).toEqual([]);
  });

  it('skips a paused ticket', () => {
    insertTicket(1, { pausedAt: '2026-09-06T22:00:00.000Z' });
    insertStage(1, 'uat');
    insertGraphRun(10, 1, 'closed');
    expect(ticketsAwaitingGraphDrive(store.db, { projectId: PROJECT })).toEqual([]);
  });

  it('skips a ticket whose current stage is blocked', () => {
    insertTicket(1);
    insertStage(1, 'uat', 'gate-tools-missing');
    insertGraphRun(10, 1, 'closed');
    expect(ticketsAwaitingGraphDrive(store.db, { projectId: PROJECT })).toEqual([]);
  });

  it('skips a ticket from another project', () => {
    insertTicket(1, { projectId: 2 });
    insertStage(1, 'uat');
    insertGraphRun(10, 1, 'closed');
    expect(ticketsAwaitingGraphDrive(store.db, { projectId: PROJECT })).toEqual([]);
  });

  it('skips a ticket that never ran a graph', () => {
    insertTicket(1, { approach: null });
    insertStage(1, 'uat');
    expect(ticketsAwaitingGraphDrive(store.db, { projectId: PROJECT })).toEqual([]);
  });

  it('returns ids in ticket order', () => {
    insertTicket(2);
    insertStage(2, 'uat');
    insertGraphRun(20, 2, 'closed');
    insertTicket(1);
    insertStage(1, 'uat');
    insertGraphRun(10, 1, 'cancelled');
    expect(ticketsAwaitingGraphDrive(store.db, { projectId: PROJECT })).toEqual([1, 2]);
  });
});
