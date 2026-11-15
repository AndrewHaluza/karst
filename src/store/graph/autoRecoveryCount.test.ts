/**
 * The per-run automatic-recovery counter (v125, @arch:GRAPHRUN): the count of
 * recoveries the coordinator ran by itself, the reasons it recovered, and the
 * stop note on a blocked run. A human recovery never touches them.
 */

import { describe, it, expect } from 'vitest';
import { openStore } from '../db.js';
import { createTicket } from '../tickets.js';
import { upsertProject } from '../projects.js';
import {
  createGraphRun,
  blockedGraphRunsForAutoRecovery,
  graphRunAutoRecovery,
  markGraphRunBlocked,
  noteGraphRunAutoRecoveryStopped,
  recordGraphRunAutoRecovery,
} from './graphRuns.js';

const NOW = '2026-11-15T00:00:00.000Z';

function openRun(): { db: ReturnType<typeof openStore>['db']; runId: number } {
  const store = openStore(':memory:');
  const ticketId = createTicket(store, { key: 'AR-1', title: 't' }).id;
  const runId = createGraphRun(store.db, { ticketId, stageAttempt: 0, approachId: 'x', now: NOW });
  return { db: store.db, runId };
}

describe('graph-run automatic recovery counter', () => {
  it('starts at zero with no reasons', () => {
    const { db, runId } = openRun();
    expect(graphRunAutoRecovery(db, runId)).toEqual({ count: 0, reasons: [] });
  });

  it('counts each recorded recovery and keeps the reasons in order', () => {
    const { db, runId } = openRun();
    recordGraphRunAutoRecovery(db, runId, 'node-blocked: n1', NOW);
    recordGraphRunAutoRecovery(db, runId, 'graph-plan-invalid: bad', NOW);
    expect(graphRunAutoRecovery(db, runId)).toEqual({
      count: 2,
      reasons: ['node-blocked: n1', 'graph-plan-invalid: bad'],
    });
  });

  it('reports zero for a run that does not exist', () => {
    const { db } = openRun();
    expect(graphRunAutoRecovery(db, 999)).toEqual({ count: 0, reasons: [] });
  });

  it('appends the stop note to a blocked reason once and keeps the reason prefix', () => {
    const { db, runId } = openRun();
    db.prepare("UPDATE approach_graph_runs SET status = 'blocked' WHERE id = ?").run(runId);
    markGraphRunBlocked(db, runId, 'node-blocked: n1', NOW);
    const note = 'automatic recovery stopped after 3 attempts (recovered: a; b; c)';
    expect(noteGraphRunAutoRecoveryStopped(db, runId, note, NOW)).toBe(true);
    expect(noteGraphRunAutoRecoveryStopped(db, runId, note, NOW)).toBe(false);
    const row = db
      .prepare('SELECT blocked_reason FROM approach_graph_runs WHERE id = ?')
      .get(runId) as { blocked_reason: string };
    expect(row.blocked_reason).toBe(`node-blocked: n1 — ${note}`);
  });

  it('does not write the stop note on a run that is no longer blocked', () => {
    const { db, runId } = openRun();
    expect(noteGraphRunAutoRecoveryStopped(db, runId, 'automatic recovery stopped after 3 attempts', NOW)).toBe(false);
  });
});

describe('blocked runs the sweep may recover on its own', () => {
  function setup(): { db: ReturnType<typeof openStore>['db']; runId: number; ticketId: number; projectId: number } {
    const store = openStore(':memory:');
    const project = upsertProject(store, { slug: 'p' });
    const ticketId = createTicket(store, { key: 'AR-2', title: 't', projectId: project.id }).id;
    const runId = createGraphRun(store.db, { ticketId, stageAttempt: 0, approachId: 'x', now: NOW });
    store.db.prepare("UPDATE approach_graph_runs SET status = 'blocked' WHERE id = ?").run(runId);
    store.db.prepare("UPDATE tickets SET stage_current = 'impl' WHERE id = ?").run(ticketId);
    return { db: store.db, runId, ticketId, projectId: project.id };
  }

  it('lists a blocked run of an unpaused, unarchived ticket at impl', () => {
    const { db, runId, ticketId, projectId } = setup();
    expect(blockedGraphRunsForAutoRecovery(db, projectId)).toEqual([{ graphRunId: runId, ticketId }]);
  });

  it.each([
    ['paused', "UPDATE tickets SET paused_at = '2026-11-15' WHERE id = ?"],
    ['archived', "UPDATE tickets SET archived_at = '2026-11-15' WHERE id = ?"],
    ['not at impl', "UPDATE tickets SET stage_current = 'uat' WHERE id = ?"],
  ])('skips a run whose ticket is %s', (_label, sql) => {
    const { db, ticketId, projectId } = setup();
    db.prepare(sql).run(ticketId);
    expect(blockedGraphRunsForAutoRecovery(db, projectId)).toEqual([]);
  });

  it('skips a run that is not blocked', () => {
    const { db, runId, projectId } = setup();
    db.prepare("UPDATE approach_graph_runs SET status = 'running' WHERE id = ?").run(runId);
    expect(blockedGraphRunsForAutoRecovery(db, projectId)).toEqual([]);
  });
});
