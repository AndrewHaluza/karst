import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from './db.js';
import { upsertProject } from './projects.js';
import { createTicket, getTicket } from './tickets.js';
import { createPlanningSession, getPlanningSession, listPlanningTickets, setPlanningSessionStatus } from './planningSessions.js';
import {
  insertProposal,
  listPendingProposals,
  getProposal,
  discardProposal,
  countPending,
  acceptProposal,
  markProposalAccepted,
  type ProposalPayload,
} from './planningProposals.js';

const payload: ProposalPayload = { title: 'Fix auth', description: 'desc', summary: 'sum', repos: ['api'] };

describe('planning proposals', () => {
  let store: Store;
  let projectId: number;
  let sessionId: number;
  beforeEach(() => {
    store = openStore(':memory:');
    projectId = upsertProject(store, { slug: 'p' }).id;
    sessionId = createPlanningSession(store, { projectId, title: 's', core: 'claude', model: null }).id;
  });
  afterEach(() => store.close());

  it('inserts a pending proposal and reads it back', () => {
    const id = insertProposal(store, sessionId, payload);
    expect(getProposal(store, id)).toMatchObject({ id, sessionId, status: 'pending', payload, ticketId: null, resolvedAt: null });
    expect(countPending(store, sessionId)).toBe(1);
  });

  it('lists pending only for the project and non-archived sessions', () => {
    const other = upsertProject(store, { slug: 'q' }).id;
    const otherSession = createPlanningSession(store, { projectId: other, title: 'o', core: 'claude', model: null }).id;
    const archived = createPlanningSession(store, { projectId, title: 'a', core: 'claude', model: null }).id;
    const a = insertProposal(store, sessionId, payload);
    insertProposal(store, otherSession, payload);
    insertProposal(store, archived, payload);
    setPlanningSessionStatus(store, archived, 'archived');
    const d = insertProposal(store, sessionId, payload);
    discardProposal(store, d);
    expect(listPendingProposals(store, projectId).map((p) => p.id)).toEqual([a]);
  });

  it('discard marks resolved and refuses non-pending', () => {
    const id = insertProposal(store, sessionId, payload);
    discardProposal(store, id);
    expect(getProposal(store, id)).toMatchObject({ status: 'discarded' });
    expect(getProposal(store, id)?.resolvedAt).not.toBeNull();
    expect(() => discardProposal(store, id)).toThrow(/not pending/);
  });

  it('accept creates, fills, links and marks the proposal in one go', () => {
    const id = insertProposal(store, sessionId, payload);
    const ticketId = acceptProposal(store, id);
    const t = getTicket(store, ticketId)!;
    expect(t).toMatchObject({ title: 'Fix auth', source: 'planning', projectId, description: 'desc', brief: 'sum' });
    expect(t.selectedRepos).toEqual(['api']);
    expect(listPlanningTickets(store, sessionId)).toEqual([ticketId]);
    expect(getPlanningSession(store, sessionId)?.status).toBe('filed');
    expect(getProposal(store, id)).toMatchObject({ status: 'accepted', ticketId });
    expect(() => acceptProposal(store, id)).toThrow(/not pending/);
  });

  it('accept refuses a proposal from another project', () => {
    const id = insertProposal(store, sessionId, payload);
    expect(() => acceptProposal(store, id, { projectId: projectId + 99 })).toThrow(/project/);
    expect(getProposal(store, id)?.status).toBe('pending');
  });

  it('accept is atomic: a failure rolls back the ticket', () => {
    const id = insertProposal(store, sessionId, payload);
    store.db.exec(`CREATE TRIGGER boom BEFORE INSERT ON planning_session_tickets BEGIN SELECT RAISE(ABORT, 'boom'); END;`);
    expect(() => acceptProposal(store, id)).toThrow(/boom/);
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM tickets').get()).toEqual({ n: 0 });
    expect(getProposal(store, id)?.status).toBe('pending');
  });

  it('deleting the session cascades its proposals', () => {
    const id = insertProposal(store, sessionId, payload);
    store.db.prepare('DELETE FROM planning_sessions WHERE id = ?').run(sessionId);
    expect(getProposal(store, id)).toBeUndefined();
  });

  it('markProposalAccepted links a form-saved ticket and resolves the proposal', () => {
    const id = insertProposal(store, sessionId, payload);
    const t = createTicket(store, { key: 'K-1', title: 'saved', projectId });
    markProposalAccepted(store, id, t.id);
    expect(getProposal(store, id)).toMatchObject({ status: 'accepted', ticketId: t.id });
    expect(listPlanningTickets(store, sessionId)).toEqual([t.id]);
    expect(() => markProposalAccepted(store, id, t.id)).toThrow(/not pending/);
  });
});
