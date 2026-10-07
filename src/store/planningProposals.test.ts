import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { openStore, type Store } from './db.js';
import { upsertProject } from './projects.js';
import { createTicket, getTicket, updateTicketFields } from './tickets.js';
import { createPlanningSession, listPlanningTickets, setPlanningSessionStatus } from './planningSessions.js';
import {
  insertProposal,
  listPendingProposals,
  listSessionProposals,
  getProposal,
  updateProposalPayload,
  discardProposal,
  countPending,
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

  it('deleting the session cascades its proposals', () => {
    const id = insertProposal(store, sessionId, payload);
    store.db.prepare('DELETE FROM planning_sessions WHERE id = ?').run(sessionId);
    expect(getProposal(store, id)).toBeUndefined();
  });

  it('markProposalAccepted links a form-saved ticket, marks it planning, copies the summary to its brief, and resolves the proposal', () => {
    const id = insertProposal(store, sessionId, payload);
    const t = createTicket(store, { key: 'K-1', title: 'saved', projectId });
    markProposalAccepted(store, id, t.id);
    expect(getProposal(store, id)).toMatchObject({ status: 'accepted', ticketId: t.id });
    expect(listPlanningTickets(store, sessionId)).toEqual([t.id]);
    const saved = getTicket(store, t.id)!;
    expect(saved.brief).toBe('sum');
    expect(saved.source).toBe('planning');
    expect(() => markProposalAccepted(store, id, t.id)).toThrow(/not pending/);
  });

  it('markProposalAccepted keeps a brief the ticket already has (but still records the origin)', () => {
    const id = insertProposal(store, sessionId, payload);
    const t = createTicket(store, { key: 'K-2', title: 'saved', projectId });
    updateTicketFields(store, t.id, { brief: 'user wrote this' });
    markProposalAccepted(store, id, t.id);
    const saved = getTicket(store, t.id)!;
    expect(saved.brief).toBe('user wrote this');
    expect(saved.source).toBe('planning');
  });
});
