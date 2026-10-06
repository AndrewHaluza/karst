import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from './db.js';
import { upsertProject } from './projects.js';
import { createTicketFlow } from '../workflow/stages/create.js';
import {
  createPlanningSession,
  getPlanningSession,
  listPlanningSessions,
  setPlanningSessionStatus,
  linkPlanningTicket,
  listPlanningTickets,
  PLANNING_TITLE_MAX,
  deletePlanningSession,
} from './planningSessions.js';

describe('planning sessions', () => {
  let store: Store;
  let projectId: number;
  beforeEach(() => {
    store = openStore(':memory:');
    projectId = upsertProject(store, { slug: 'p' }).id;
  });
  afterEach(() => store.close());

  it('creates an active session scoped to its project', () => {
    const s = createPlanningSession(store, { projectId, title: 'Investigate auth', core: 'claude', model: 'opus' });
    expect(s).toMatchObject({ projectId, title: 'Investigate auth', core: 'claude', model: 'opus', status: 'active' });
    expect(s).not.toHaveProperty('agentSessionId');
    expect(getPlanningSession(store, s.id)).toEqual(s);
  });

  it('rejects a blank title', () => {
    expect(() => createPlanningSession(store, { projectId, title: '  ', core: 'claude', model: null })).toThrow(/title/);
  });

  it('lists only the given project, newest first, excluding archived by default', () => {
    const other = upsertProject(store, { slug: 'q' }).id;
    const a = createPlanningSession(store, { projectId, title: 'a', core: 'claude', model: null });
    const b = createPlanningSession(store, { projectId, title: 'b', core: 'codex', model: null });
    createPlanningSession(store, { projectId: other, title: 'x', core: 'claude', model: null });
    setPlanningSessionStatus(store, a.id, 'archived');
    expect(listPlanningSessions(store, projectId).map((s) => s.title)).toEqual(['b']);
    expect(listPlanningSessions(store, projectId, { includeArchived: true }).map((s) => s.id)).toEqual([b.id, a.id]);
  });

  it('collapses whitespace and control characters in the title and caps its length', () => {
    const s = createPlanningSession(store, { projectId, title: '  a\n\tb\u0007  c\u001b[31m ', core: 'claude', model: null });
    expect(s.title).toBe('a b c [31m');
    const long = createPlanningSession(store, { projectId, title: 'x'.repeat(500), core: 'claude', model: null });
    expect(long.title).toHaveLength(PLANNING_TITLE_MAX);
  });

  it('rejects a title made only of control characters', () => {
    expect(() => createPlanningSession(store, { projectId, title: '\u0000\u0007', core: 'claude', model: null })).toThrow(/title/);
  });

  it('has no resume columns (resume is out of scope for v65)', () => {
    const cols = (store.db.prepare('PRAGMA table_info(planning_sessions)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).not.toContain('agent_session_id');
    expect(cols).not.toContain('transcript_path');
  });

  it('links tickets idempotently and marks the session filed', () => {
    const s = createPlanningSession(store, { projectId, title: 't', core: 'claude', model: null });
    const t1 = createTicketFlow(store, { key: 'T-1', title: 'one' }).id;
    const t2 = createTicketFlow(store, { key: 'T-2', title: 'two' }).id;
    linkPlanningTicket(store, s.id, t1);
    linkPlanningTicket(store, s.id, t1);
    linkPlanningTicket(store, s.id, t2);
    expect(listPlanningTickets(store, s.id)).toEqual([t1, t2]);
    expect(getPlanningSession(store, s.id)?.status).toBe('filed');
  });

  it('throws on an unknown session', () => {
    expect(() => setPlanningSessionStatus(store, 999, 'archived')).toThrow(/999/);
  });

  it('deletes a session (a create whose launch failed)', () => {
    const s = createPlanningSession(store, { projectId, title: 't', core: 'claude', model: null });
    deletePlanningSession(store, s.id);
    expect(getPlanningSession(store, s.id)).toBeUndefined();
  });
});
