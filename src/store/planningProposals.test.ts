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
  validateProposalDependsOn,
  type ProposalPayload,
} from './planningProposals.js';
import { listRelations } from './ticketRelations.js';
import { listInbox } from './ticketMessages.js';

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
         payload_json TEXT NOT NULL, depends_on TEXT NOT NULL DEFAULT '[]',
         depends_dropped TEXT NOT NULL DEFAULT '[]',
         status TEXT NOT NULL DEFAULT 'pending',
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

  it('stores dependsOn and replaces (or clears) it on revise', () => {
    const id = insertProposal(store, sessionId, { ...payload, dependsOn: [3, 1] });
    expect(getProposal(store, id)!.payload.dependsOn).toEqual([3, 1]);
    updateProposalPayload(store, id, { ...payload, dependsOn: [5] });
    expect(getProposal(store, id)!.payload.dependsOn).toEqual([5]);
    updateProposalPayload(store, id, { ...payload });
    expect(getProposal(store, id)!.payload.dependsOn ?? []).toEqual([]);
  });

  it('proposalPayloadEquals compares dependsOn', () => {
    expect(proposalPayloadEquals({ ...payload, dependsOn: [] }, payload)).toBe(true);
    expect(proposalPayloadEquals({ ...payload, dependsOn: [1] }, { ...payload, dependsOn: [1] })).toBe(true);
    expect(proposalPayloadEquals({ ...payload, dependsOn: [1] }, { ...payload, dependsOn: [2] })).toBe(false);
  });

  it('validateProposalDependsOn rejects unknown, foreign and discarded ids, and cycles', () => {
    const a = insertProposal(store, sessionId, payload);
    const other = createPlanningSession(store, { projectId, title: 'o2', core: 'claude', model: null }).id;
    const foreign = insertProposal(store, other, payload);
    const gone = insertProposal(store, sessionId, payload);
    discardProposal(store, gone);

    expect(validateProposalDependsOn(store, sessionId, undefined, [a])).toBeUndefined();
    expect(validateProposalDependsOn(store, sessionId, undefined, [999])).toMatch(/not a proposal of this session/);
    expect(validateProposalDependsOn(store, sessionId, undefined, [foreign])).toMatch(/not a proposal of this session/);
    expect(validateProposalDependsOn(store, sessionId, undefined, [gone])).toMatch(/discarded/);

    // b waits on a; revising a to wait on b would close a→b→a.
    const b = insertProposal(store, sessionId, { ...payload, dependsOn: [a] });
    expect(validateProposalDependsOn(store, sessionId, undefined, [b])).toBeUndefined();
    expect(validateProposalDependsOn(store, sessionId, a, [b])).toMatch(/cycle/);
  });

  it('accept resolves a dependency to a proposal link regardless of accept order', () => {
    const p1 = insertProposal(store, sessionId, payload);
    const p2 = insertProposal(store, sessionId, { ...payload, title: 'p2', dependsOn: [p1] });
    const t1 = createTicket(store, { key: 'K1', title: 't1', projectId }).id;
    const t2 = createTicket(store, { key: 'K2', title: 't2', projectId }).id;

    // The dependent is accepted FIRST, while its prerequisite is still pending.
    markProposalAccepted(store, p2, t2);
    let rel = listRelations(store, t2).filter((r) => r.kind === 'blocked-by');
    expect(rel).toHaveLength(1);
    expect(rel[0]).toMatchObject({ targetTicketId: null, targetProposalId: p1, source: 'agent' });

    // Accepting the prerequisite converts the pending link to a ticket link.
    markProposalAccepted(store, p1, t1);
    rel = listRelations(store, t2).filter((r) => r.kind === 'blocked-by');
    expect(rel).toHaveLength(1);
    expect(rel[0]).toMatchObject({ targetTicketId: t1, targetProposalId: null, source: 'agent' });
  });

  it('accept links the ticket directly when the prerequisite is accepted first', () => {
    const p1 = insertProposal(store, sessionId, payload);
    const p2 = insertProposal(store, sessionId, { ...payload, title: 'p2', dependsOn: [p1] });
    const t1 = createTicket(store, { key: 'K1', title: 't1', projectId }).id;
    const t2 = createTicket(store, { key: 'K2', title: 't2', projectId }).id;
    markProposalAccepted(store, p1, t1);
    markProposalAccepted(store, p2, t2);
    const rel = listRelations(store, t2).filter((r) => r.kind === 'blocked-by');
    expect(rel).toHaveLength(1);
    expect(rel[0]).toMatchObject({ targetTicketId: t1, targetProposalId: null, source: 'agent' });
  });

  it('promotes a converted dependency to a pending provider write-back once both tickets are bound', () => {
    const p1 = insertProposal(store, sessionId, payload);
    const p2 = insertProposal(store, sessionId, { ...payload, title: 'p2', dependsOn: [p1] });
    const t1 = createTicket(store, { key: 'K1', title: 't1', projectId }).id;
    const t2 = createTicket(store, { key: 'K2', title: 't2', projectId }).id;
    updateTicketFields(store, t1, { sourceRef: 'CU-1' });
    updateTicketFields(store, t2, { sourceRef: 'CU-2' });

    markProposalAccepted(store, p2, t2); // p1 pending → a proposal link, not yet writable
    markProposalAccepted(store, p1, t1); // converts to a ticket link and arms the write-back

    const rel = listRelations(store, t2).find((r) => r.kind === 'blocked-by')!;
    expect(rel).toMatchObject({ targetTicketId: t1, targetProposalId: null, writebackState: 'pending' });
  });

  it('discard deletes rows targeting the proposal, warns dependents, and prunes every depends_on', () => {
    const p1 = insertProposal(store, sessionId, payload);
    const p2 = insertProposal(store, sessionId, { ...payload, title: 'p2', dependsOn: [p1] });
    const p3 = insertProposal(store, sessionId, { ...payload, title: 'p3', dependsOn: [p1] });
    const t2 = createTicket(store, { key: 'K2', title: 't2', projectId }).id;
    markProposalAccepted(store, p2, t2);
    expect(listRelations(store, t2).filter((r) => r.kind === 'blocked-by')).toHaveLength(1);

    const pruned = discardProposal(store, p1);

    expect(pruned).toEqual([p3]);
    expect(listRelations(store, t2)).toEqual([]);
    const inbox = listInbox(store, t2, { unreadOnly: false });
    expect(inbox.some((m) => m.kind === 'event' && m.body.includes(`#${p1}`))).toBe(true);
    // The still-pending dependent loses the edge and records it for the card warning.
    expect(getProposal(store, p3)!.payload.dependsOn ?? []).toEqual([]);
    expect(getProposal(store, p3)!.droppedDepends).toEqual([p1]);
    // The accepted dependent stops advertising a draft that no longer exists.
    expect(getProposal(store, p2)!.payload.dependsOn ?? []).toEqual([]);
    expect(getProposal(store, p2)!.droppedDepends).toEqual([]);
  });

  it('a revision clears the dropped-dependency warning', () => {
    const p1 = insertProposal(store, sessionId, payload);
    const p2 = insertProposal(store, sessionId, { ...payload, title: 'p2', dependsOn: [p1] });
    discardProposal(store, p1);
    expect(getProposal(store, p2)!.droppedDepends).toEqual([p1]);
    updateProposalPayload(store, p2, { ...payload, title: 'p2', dependsOn: [] });
    expect(getProposal(store, p2)!.droppedDepends).toEqual([]);
  });
});
