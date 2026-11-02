import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../db.js';
import { upsertProject } from '../projects.js';
import { createTicket } from '../tickets.js';
import { createPlanningSession } from '../planningSessions.js';
import { collectPlanning, LOW_SAMPLE_THRESHOLD } from './planning.js';
import { scopeSql } from './scope.js';

const NOW = new Date('2026-02-01T00:00:00Z');

describe('collectPlanning', () => {
  let store: Store;
  let projectId: number;
  let sessionId: number;
  beforeEach(() => {
    store = openStore(':memory:');
    projectId = upsertProject(store, { slug: 'demo' }).id;
    sessionId = createPlanningSession(store, { projectId, title: 's', core: 'claude', model: 'opus' }).id;
  });
  afterEach(() => store.close());

  function draft(opts: {
    status?: 'pending' | 'accepted' | 'discarded';
    payload?: object | string;
    dependsOn?: number[];
    session?: number;
    ticketKey?: string;
    stage?: string;
    merged?: string;
    createdAt?: string;
  }): { proposalId: number; ticketId: number | null } {
    const payload =
      typeof opts.payload === 'string'
        ? opts.payload
        : JSON.stringify({ title: 'Draft', description: 'SECRET', summary: 'sum', repos: ['a'], ...opts.payload });
    let ticketId: number | null = null;
    if (opts.ticketKey) {
      const t = createTicket(store, { key: opts.ticketKey, title: 't', projectId });
      ticketId = t.id;
      if (opts.stage) store.db.prepare('UPDATE tickets SET stage_current = ? WHERE id = ?').run(opts.stage, ticketId);
      if (opts.merged) {
        store.db.prepare('INSERT INTO prs (ticket_id, repo, merged_at) VALUES (?, ?, ?)').run(ticketId, 'r', opts.merged);
      }
    }
    const { lastInsertRowid } = store.db
      .prepare(
        'INSERT INTO planning_proposals (session_id, payload_json, depends_on, status, ticket_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        opts.session ?? sessionId,
        payload,
        JSON.stringify(opts.dependsOn ?? []),
        opts.status ?? 'accepted',
        ticketId,
        opts.createdAt ?? '2026-01-01 00:00:00',
        '2026-01-01 00:00:00',
      );
    return { proposalId: Number(lastInsertRowid), ticketId };
  }

  it('counts the funnel per session and in total, and names the unreadable revise signal', () => {
    const other = createPlanningSession(store, { projectId, title: 'o', core: 'codex', model: null }).id;
    draft({ status: 'pending' });
    draft({ status: 'discarded' });
    draft({ status: 'accepted', ticketKey: 'A' });
    draft({ status: 'accepted', ticketKey: 'B', session: other });
    const r = collectPlanning(store, {}, NOW);
    expect(r.funnel.total).toEqual({ pending: 1, accepted: 2, discarded: 1, total: 4 });
    expect(r.funnel.bySession).toHaveLength(2);
    expect(r.funnel.bySession.find((s) => s.sessionId === other)).toMatchObject({ core: 'codex', model: null, accepted: 1, total: 1 });
    expect(r.funnel.revisedBeforeAccept.value).toBeNull();
    expect(r.funnel.revisedBeforeAccept.missing).toMatch(/revised_at/);
  });

  it('reports missing sources as null, not 0, and merged time from proposal creation', () => {
    draft({ ticketKey: 'A', merged: '2026-01-02 00:00:00' });
    draft({ ticketKey: 'B' });
    const o = collectPlanning(store, {}, NOW).outcome;
    expect(o).toMatchObject({ tickets: 2, merged: 1, mergedRate: 0.5, medianHoursToMerge: 24 });
    expect(o.firstPassRate).toBeNull();
    expect(o.reworkRounds).toBeNull();
    expect(o.fixRounds).toBeNull();
    expect(o.gateKills).toBeNull();
    expect(o.reportedTokens).toBeNull();
    expect(o.agentActiveHours).toBeNull();
  });

  it('reuses the metric queries restricted to the draft-born tickets', () => {
    const { ticketId } = draft({ ticketKey: 'A' });
    const manual = createTicket(store, { key: 'M', title: 'm', projectId });
    const run = store.db.prepare(
      "INSERT INTO gate_runs (ticket_id, stage_key, attempt, gate_name, exit_code, run_at) VALUES (?, 'uat', 0, 'g', 1, '2026-01-02 00:00:00')",
    );
    run.run(ticketId);
    run.run(manual.id);
    expect(collectPlanning(store, {}, NOW).outcome.gateKills).toBe(1);
  });

  it('buckets traits, marks LOW below the threshold, and never prints draft text', () => {
    draft({ ticketKey: 'A', payload: { constraints: [] } });
    draft({ ticketKey: 'B', payload: { constraints: ['1', '2'], repos: ['a', 'b', 'c'] }, dependsOn: [1] });
    draft({ ticketKey: 'C', payload: { constraints: ['1', '2', '3', '4', '5', '6'] } });
    draft({ ticketKey: 'D', payload: '{not json' });
    const r = collectPlanning(store, {}, NOW);
    const split = (name: string) => r.splits.find((s) => s.name === name)!.buckets;
    expect(split('constraints').map((b) => b.bucket)).toEqual(['0', '1-5', '6+', 'unreadable']);
    expect(split('dependsOn').find((b) => b.bucket === 'has dependsOn')!.drafts).toBe(1);
    expect(split('repos').map((b) => b.bucket)).toContain('3+');
    expect(split('summary length').length).toBeGreaterThan(0);
    expect(split('core/model')[0]).toMatchObject({ bucket: 'claude/opus', drafts: 4, low: true });
    expect(LOW_SAMPLE_THRESHOLD).toBe(10);
    expect(JSON.stringify(r)).not.toContain('SECRET');
  });

  it('is not LOW at the threshold', () => {
    for (let i = 0; i < LOW_SAMPLE_THRESHOLD; i++) draft({ ticketKey: `K${i}` });
    expect(collectPlanning(store, {}, NOW).splits[0]!.buckets[0]!.low).toBe(false);
  });

  it('lists accepted drafts whose ticket is neither done nor archived, with age', () => {
    draft({ ticketKey: 'A', stage: 'impl', payload: { title: 'Stuck one' } });
    draft({ ticketKey: 'B', stage: 'done' });
    const archived = draft({ ticketKey: 'C', stage: 'impl' });
    store.db.prepare("UPDATE tickets SET archived_at = datetime('now') WHERE id = ?").run(archived.ticketId);
    const { stuck } = collectPlanning(store, {}, NOW);
    expect(stuck).toHaveLength(1);
    expect(stuck[0]).toMatchObject({ title: 'Stuck one', stage: 'impl', ageHours: 31 * 24 });
  });

  it('honours --project and --since', () => {
    const otherProject = upsertProject(store, { slug: 'other' }).id;
    const otherSession = createPlanningSession(store, { projectId: otherProject, title: 'x', core: 'claude', model: null }).id;
    draft({ status: 'pending' });
    draft({ status: 'pending', session: otherSession });
    draft({ status: 'pending', createdAt: '2026-01-20 00:00:00' });
    expect(collectPlanning(store, { projectId }, NOW).funnel.total.total).toBe(2);
    expect(collectPlanning(store, { since: '2026-01-10' }, NOW).funnel.total.total).toBe(1);
  });
});

describe('scopeSql ticketIds', () => {
  it('matches nothing for an empty set and needs a ticket column off the tickets alias', () => {
    expect(scopeSql({ ticketIds: [] }, { projectColumn: 't.project_id' }).clause).toBe(' AND 0');
    expect(scopeSql({ ticketIds: [1, 2] }, { projectColumn: 't.project_id' })).toEqual({
      clause: ' AND t.id IN (?, ?)',
      params: [1, 2],
    });
    expect(() => scopeSql({ ticketIds: [1] }, { projectColumn: 'u.project_id' })).toThrow(/ticketColumn/);
  });
});
