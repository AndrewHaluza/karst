import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { openStore, type Store } from './db.js';
import { upsertProject } from './projects.js';
import { createTicket, getTicket, listTickets } from './tickets.js';
import { createPlanningSession, getPlanningSession, listPlanningTickets, setPlanningSessionStatus } from './planningSessions.js';
import {
  insertProposal,
  listPendingProposals,
  listSessionProposals,
  getProposal,
  updateProposalPayload,
  discardProposal,
  countPending,
  acceptProposal,
  markProposalAccepted,
  proposalPayloadEquals,
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

  it('updateProposalPayload replaces the payload in place and refuses non-pending', () => {
    const id = insertProposal(store, sessionId, payload);
    updateProposalPayload(store, id, { ...payload, title: 'Revised', repos: ['api', 'web'] });
    expect(getProposal(store, id)).toMatchObject({ id, status: 'pending', payload: { title: 'Revised', repos: ['api', 'web'] } });
    discardProposal(store, id);
    expect(() => updateProposalPayload(store, id, payload)).toThrow(/not pending/);
    expect(getProposal(store, id)?.payload.title).toBe('Revised');
  });

  it('persists sourceUuid on insert and on an in-place revise', () => {
    const id = insertProposal(store, sessionId, payload, 'uuid-a');
    expect(getProposal(store, id)!.sourceUuid).toBe('uuid-a');
    updateProposalPayload(store, id, { ...payload, title: 'Revised' }, 'uuid-b');
    expect(getProposal(store, id)!.sourceUuid).toBe('uuid-b');
    // Without a uuid the revise leaves it untouched.
    updateProposalPayload(store, id, { ...payload, title: 'Again' });
    expect(getProposal(store, id)!.sourceUuid).toBe('uuid-b');
  });

  it('acceptProposal refuses when the payload was revised after the preview', () => {
    const id = insertProposal(store, sessionId, payload);
    const reviewed = getProposal(store, id)!.payload;
    updateProposalPayload(store, id, { ...payload, description: 'revised while the modal was open' });
    expect(() => acceptProposal(store, id, { expectedPayload: reviewed })).toThrow(/changed since it was reviewed/);
    expect(getProposal(store, id)!.status).toBe('pending');
    expect(listTickets(store, { projectId })).toHaveLength(0);
  });

  it('markProposalAccepted links and accepts even when the payload was revised meanwhile', () => {
    // The form's ticket is what the human saw and saved; a mid-form revision
    // must not orphan it. The ops layer warns about the divergence.
    const id = insertProposal(store, sessionId, payload);
    const t = createTicket(store, { key: 'K', title: 'Fix auth', projectId });
    updateProposalPayload(store, id, { ...payload, title: 'revised while the form was open' });
    markProposalAccepted(store, id, t.id);
    expect(getProposal(store, id)).toMatchObject({ status: 'accepted', ticketId: t.id });
    expect(listPlanningTickets(store, sessionId)).toEqual([t.id]);
  });

  it('proposalPayloadEquals compares content, not identity or key order', () => {
    expect(proposalPayloadEquals(payload, { ...payload })).toBe(true);
    expect(proposalPayloadEquals(payload, { ...payload, repos: ['api', 'web'] })).toBe(false);
    expect(proposalPayloadEquals(payload, { ...payload, title: 'other' })).toBe(false);
  });

  it('acceptProposal accepts when the payload still matches the preview', () => {
    const id = insertProposal(store, sessionId, payload);
    const reviewed = getProposal(store, id)!.payload;
    expect(acceptProposal(store, id, { expectedPayload: reviewed })).toBeGreaterThan(0);
    expect(getProposal(store, id)!.status).toBe('accepted');
  });

  it('listSessionProposals returns every status of one session, oldest first', () => {
    const a = insertProposal(store, sessionId, payload);
    const b = insertProposal(store, sessionId, payload);
    discardProposal(store, a);
    const other = createPlanningSession(store, { projectId, title: 'o', core: 'claude', model: null }).id;
    insertProposal(store, other, payload);
    expect(listSessionProposals(store, sessionId).map((p) => [p.id, p.status])).toEqual([
      [a, 'discarded'],
      [b, 'pending'],
    ]);
  });

  it('carries an updatedAt equal to createdAt on insert, moving on update', () => {
    const id = insertProposal(store, sessionId, payload);
    const created = getProposal(store, id)!;
    expect(created.updatedAt).toBe(created.createdAt);
    updateProposalPayload(store, id, { ...payload, title: 'Revised' });
    expect(getProposal(store, id)!.updatedAt).toBeTruthy();
  });

  it('coalesces a NULL updated_at to createdAt (the migrated v65 column has no default)', () => {
    // A migrated v65 DB's v66 column is nullable (SQLite forbids a function
    // default in ALTER TABLE ADD COLUMN), unlike the fresh schema's NOT NULL
    // column — so model that shape directly.
    const raw = new Database(':memory:');
    raw.exec(
      `CREATE TABLE planning_proposals (
         id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER NOT NULL,
         payload_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
         ticket_id INTEGER, source_uuid TEXT NOT NULL DEFAULT '',
         created_at TEXT NOT NULL DEFAULT (datetime('now')),
         updated_at TEXT, resolved_at TEXT)`,
    );
    const nullable = { db: raw } as unknown as Store;
    try {
      const id = insertProposal(nullable, 1, payload);
      raw.prepare('UPDATE planning_proposals SET updated_at = NULL WHERE id = ?').run(id);
      const p = getProposal(nullable, id)!;
      expect(p.updatedAt).toBe(p.createdAt);
    } finally {
      raw.close();
    }
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
