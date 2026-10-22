import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from './db.js';
import { createTicketFlow } from '../workflow/stages/create.js';
import { setStage } from './stages.js';
import { pauseTicket, archiveTicket } from './tickets.js';
import { upsertProject } from './projects.js';
import { openProcessRun } from './processRuns.js';
import { selectStrandedStages, STRANDED_STAGE_GRACE_MS } from './strandedStages.js';

const T0 = '2026-10-21T10:00:00.000Z';
const LATER = new Date(Date.parse(T0) + STRANDED_STAGE_GRACE_MS + 1000).toISOString();

describe('selectStrandedStages', () => {
  let store: Store;
  let id: number;
  let projectId: number;
  const select = (at = LATER, pid: number | null = projectId) =>
    selectStrandedStages(store, { at, projectId: pid });

  beforeEach(() => {
    store = openStore(':memory:');
    projectId = upsertProject(store, { slug: 'p' }).id;
    id = createTicketFlow(store, { key: 'T-1', title: 't', projectId }).id;
    store.db.prepare("UPDATE tickets SET stage_current = 'uat' WHERE id = ?").run(id);
    setStage(store, id, 'uat', { status: 'running', startedAt: T0 });
  });
  afterEach(() => store.close());

  it('matches a running gate stage with no run behind it', () => {
    expect(select()).toEqual([{ ticketId: id, stageKey: 'uat', attempt: 0 }]);
  });

  it('ignores a row within the grace period', () => {
    expect(select(new Date(Date.parse(T0) + 1000).toISOString())).toEqual([]);
  });

  it('ignores a row with an open stage run for the attempt', () => {
    store.db
      .prepare(
        `INSERT INTO stage_runs (ticket_id, stage_key, attempt, run_at, status, started_at)
         VALUES (?, 'uat', 0, ?, 'running', ?)`,
      )
      .run(id, T0, T0);
    expect(select()).toEqual([]);
  });

  it('ignores a ticket with an open process run', () => {
    openProcessRun(store, { ticketId: id, stageKey: 'uat', processId: 'gates', attempt: 0, startedAt: T0 });
    expect(select()).toEqual([]);
  });

  it('ignores paused, archived and blocked tickets and other projects', () => {
    expect(select(LATER, projectId + 1)).toEqual([]);
    expect(select(LATER, null)).toEqual([]);
    setStage(store, id, 'uat', { blockedKind: 'boot-failed', blockedReason: 'x', blockedAt: T0 });
    expect(select()).toEqual([]);
    setStage(store, id, 'uat', { blockedKind: null, blockedReason: null, blockedAt: null });
    pauseTicket(store, id);
    expect(select()).toEqual([]);
  });

  it('ignores an archived ticket', () => {
    archiveTicket(store, id);
    expect(select()).toEqual([]);
  });
});
