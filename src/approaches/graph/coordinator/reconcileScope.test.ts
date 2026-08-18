import { describe, it, expect } from 'vitest';
import { openStore } from '../../../store/db.js';
import { reconcilableGraphRunIds, NON_TERMINAL_GRAPH_RUN_STATUSES } from './reconcileScope.js';

function insertRun(
  db: ReturnType<typeof openStore>['db'],
  id: number,
  ticketId: number,
  stageAttempt: number,
  status: string,
): void {
  db.prepare(
    `INSERT INTO approach_graph_runs
       (id, ticket_id, stage_key, stage_attempt, approach_id, status, created_at)
     VALUES (?, ?, 'impl', ?, 'a', ?, '2026-08-12T00:00:00.000Z')`,
  ).run(id, ticketId, stageAttempt, status);
}

describe('reconcilableGraphRunIds (G1b)', () => {
  it('scopes to the project and excludes terminal statuses', () => {
    const { db } = openStore(':memory:');
    db.prepare("INSERT INTO tickets (id, key, project_id) VALUES (1, 'A-1', 1)").run();
    db.prepare("INSERT INTO tickets (id, key, project_id) VALUES (2, 'B-1', 2)").run();

    insertRun(db, 1, 1, 1, 'running'); // project 1, non-terminal — included
    insertRun(db, 2, 1, 2, 'draining'); // project 1, non-terminal — included (must stay in)
    insertRun(db, 3, 1, 3, 'planning'); // project 1, non-terminal — included
    insertRun(db, 4, 1, 4, 'closed'); // project 1, terminal — excluded
    insertRun(db, 5, 1, 5, 'stale'); // project 1, terminal — excluded
    insertRun(db, 6, 1, 6, 'cancelled'); // project 1, terminal — excluded
    insertRun(db, 7, 2, 1, 'running'); // project 2, non-terminal — excluded (other project)

    expect(reconcilableGraphRunIds(db, { projectId: 1 })).toEqual([1, 2, 3]);
    expect(reconcilableGraphRunIds(db, { projectId: 2 })).toEqual([7]);
  });

  it('non-terminal statuses cover every status with a transition exit, and only those', () => {
    expect([...NON_TERMINAL_GRAPH_RUN_STATUSES].sort()).toEqual(
      [
        'planning',
        'awaiting-confirmation',
        'running',
        'draining',
        'blocked',
        'completed-awaiting-impl-marker',
      ].sort(),
    );
    expect(NON_TERMINAL_GRAPH_RUN_STATUSES).not.toContain('closed');
    expect(NON_TERMINAL_GRAPH_RUN_STATUSES).not.toContain('stale');
    expect(NON_TERMINAL_GRAPH_RUN_STATUSES).not.toContain('cancelled');
    expect(NON_TERMINAL_GRAPH_RUN_STATUSES).toContain('draining');
  });
});
