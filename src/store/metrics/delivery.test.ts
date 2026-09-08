import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../db.js';
import { createTicket } from '../tickets.js';
import { upsertProject } from '../projects.js';
import {
  cycleTime,
  escapedDefects,
  firstPassRate,
  mergeFriction,
  shipFailures,
} from './delivery.js';

/**
 * Delivery-family metrics. Each test seeds ONLY the rows its metric reads, so a
 * failure names one query rather than one fixture.
 */
describe('delivery metrics', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  const stageRun = (
    ticketId: number,
    stageKey: string,
    attempt: number,
    outcome: string,
    runAt = '2026-07-20T12:00:00.000Z',
  ): void => {
    store.db
      .prepare(
        `INSERT INTO stage_runs (ticket_id, stage_key, attempt, run_at, status, outcome, started_at)
         VALUES (?, ?, ?, ?, 'finished', ?, ?)`,
      )
      .run(ticketId, stageKey, attempt, runAt, outcome, runAt);
  };

  it('counts first-attempt advances as the first-pass rate, per stage', () => {
    const p = upsertProject(store, { slug: 'p' });
    const a = createTicket(store, { key: 'A', title: 'a', projectId: p.id });
    const b = createTicket(store, { key: 'B', title: 'b', projectId: p.id });
    stageRun(a.id, 'review', 0, 'advanced');
    stageRun(b.id, 'review', 0, 'blocked');
    stageRun(b.id, 'review', 1, 'advanced');

    const result = firstPassRate(store, { projectId: p.id });
    const review = result.byStage.find((s) => s.stageKey === 'review')!;
    expect(review).toMatchObject({ advanced: 2, blocked: 1, stopped: 0, firstAttempts: 2, firstAttemptAdvanced: 1 });
    expect(review.rate).toBeCloseTo(0.5);
    expect(result.overall.rate).toBeCloseTo(0.5);
  });

  it('excludes other projects and rows older than --since', () => {
    const p = upsertProject(store, { slug: 'p' });
    const other = upsertProject(store, { slug: 'other' });
    const mine = createTicket(store, { key: 'A', title: 'a', projectId: p.id });
    const theirs = createTicket(store, { key: 'B', title: 'b', projectId: other.id });
    stageRun(mine.id, 'review', 0, 'advanced', '2026-01-01T00:00:00.000Z');
    stageRun(mine.id, 'review', 0, 'advanced', '2026-08-01T00:00:00.000Z');
    stageRun(theirs.id, 'review', 0, 'advanced', '2026-08-01T00:00:00.000Z');

    const result = firstPassRate(store, { projectId: p.id, since: '2026-07-01T00:00:00.000Z' });
    expect(result.overall.advanced).toBe(1);
  });

  it('measures cycle time from ticket creation to the last repo merge', () => {
    const t = createTicket(store, { key: 'A', title: 'a' });
    store.db
      .prepare('UPDATE tickets SET created_at = ? WHERE id = ?')
      .run('2026-07-20T00:00:00.000Z', t.id);
    const pr = (repo: string, mergedAt: string | null): void => {
      store.db
        .prepare('INSERT INTO prs (ticket_id, repo, number, merged_at) VALUES (?, ?, 1, ?)')
        .run(t.id, repo, mergedAt);
    };
    pr('one', '2026-07-20T06:00:00.000Z');
    pr('two', '2026-07-21T00:00:00.000Z');

    const result = cycleTime(store, {});
    expect(result.mergedTickets).toBe(1);
    expect(result.medianHours).toBeCloseTo(24);
  });

  it('reports no cycle time when nothing merged', () => {
    createTicket(store, { key: 'A', title: 'a' });
    const result = cycleTime(store, {});
    expect(result).toMatchObject({ mergedTickets: 0, medianHours: null, meanHours: null, p90Hours: null });
  });

  it('counts follow-up tickets as escaped defects', () => {
    const parent = createTicket(store, { key: 'A', title: 'a' });
    createTicket(store, { key: 'B', title: 'b', parentTicketId: parent.id });
    const result = escapedDefects(store, {});
    expect(result).toMatchObject({ tickets: 2, followUps: 1, parentsWithFollowUps: 1 });
    expect(result.rate).toBeCloseTo(0.5);
  });

  it('reports the conflicted share of merge checks', () => {
    const t = createTicket(store, { key: 'A', title: 'a' });
    const check = (repo: string, state: string): void => {
      store.db
        .prepare('INSERT INTO merge_checks (ticket_id, repo, state, files, checked_at) VALUES (?, ?, ?, ?, ?)')
        .run(t.id, repo, state, '[]', '2026-07-20T00:00:00.000Z');
    };
    check('one', 'conflicted');
    check('two', 'clean');
    const result = mergeFriction(store, {});
    expect(result).toMatchObject({ checks: 2, conflicted: 1 });
    expect(result.conflictRate).toBeCloseTo(0.5);
    expect(result.byState).toEqual([
      { state: 'clean', count: 1 },
      { state: 'conflicted', count: 1 },
    ]);
  });

  it('groups failed ship steps by step', () => {
    const t = createTicket(store, { key: 'A', title: 'a' });
    const run = store.db
      .prepare(
        `INSERT INTO ship_runs (ticket_id, attempt, status, started_at) VALUES (?, 0, 'failed', ?)`,
      )
      .run(t.id, '2026-07-20T00:00:00.000Z');
    const step = (name: string, status: string): void => {
      store.db
        .prepare(
          `INSERT INTO ship_repo_steps (ship_run_id, repo, step, status, detail, started_at)
           VALUES (?, 'one', ?, ?, '', '2026-07-20T00:00:00.000Z')`,
        )
        .run(Number(run.lastInsertRowid), name, status);
    };
    step('push', 'failed');
    step('pr', 'failed');
    step('commit', 'passed');

    const result = shipFailures(store, {});
    expect(result.steps).toBe(3);
    expect(result.failed).toBe(2);
    expect(result.byStep).toEqual([
      { step: 'pr', failed: 1 },
      { step: 'push', failed: 1 },
    ]);
  });
});
