import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from './db.js';
import { upsertProject } from './projects.js';
import { createTicket } from './tickets.js';
import { createPlanningSession } from './planningSessions.js';
import { insertProposal, discardProposal, markProposalAccepted, setProposalPriorityOverride } from './planningProposals.js';
import { addRelation } from './ticketRelations.js';
import { readProjectQueue } from './queueItems.js';

const payload = { title: 'A draft', description: 'd', summary: 's', repos: ['api'] };

describe('readProjectQueue', () => {
  let store: Store;
  let projectId: number;
  let s1: number;
  let s2: number;
  beforeEach(() => {
    store = openStore(':memory:');
    projectId = upsertProject(store, { slug: 'p' }).id;
    s1 = createPlanningSession(store, { projectId, title: 'one', core: 'claude', model: null }).id;
    s2 = createPlanningSession(store, { projectId, title: 'two', core: 'claude', model: null }).id;
  });
  afterEach(() => store.close());

  const ticket = (key: string, stage: string, extra = ''): number => {
    const t = createTicket(store, { key, title: `title ${key}`, projectId });
    store.db.prepare(`UPDATE tickets SET stage_current = '${stage}'${extra} WHERE id = ?`).run(t.id);
    return t.id;
  };
  const ids = (): string[] => readProjectQueue(store, projectId).entries.map((e) => e.id);

  it('is empty for an empty project', () => {
    expect(readProjectQueue(store, projectId)).toEqual({ entries: [], drafts: 0, sessions: 0, tickets: 0 });
  });

  it('orders drafts of two sessions and scope tickets by priority, then age, then id, and counts them', () => {
    const low = insertProposal(store, s1, { ...payload, priority: 'low' });
    const high = insertProposal(store, s2, { ...payload, priority: 'high' });
    const plain = insertProposal(store, s2, payload);
    const t = ticket('K1', 'scope', ", priority = 'urgent'");
    const q = readProjectQueue(store, projectId);
    expect(q.entries.map((e) => e.id)).toEqual([`T${t}`, `D${high}`, `D${plain}`, `D${low}`]);
    expect(q.entries.map((e) => e.position)).toEqual([1, 2, 3, 4]);
    expect(q).toMatchObject({ drafts: 3, sessions: 2, tickets: 1 });
    expect(q.entries[1]).toMatchObject({ kind: 'draft', numId: high, session: `P${s2}`, title: 'A draft', ownPriority: 'high' });
    expect(q.entries[0]).toMatchObject({ kind: 'ticket', session: null, title: 'title K1' });
  });

  it('orders a ticket by its effective priority and names the source of every row', () => {
    const provider = ticket('K1', 'scope', ", priority = 'normal'");
    const you = ticket('K2', 'scope', ", priority = 'low', priority_override = 'urgent'");
    const planner = insertProposal(store, s1, { ...payload, priority: 'high' });
    const mine = insertProposal(store, s1, { ...payload, priority: 'urgent' });
    setProposalPriorityOverride(store, mine, 'low');
    const q = readProjectQueue(store, projectId);
    expect(q.entries.map((e) => [e.id, e.ownPriority, e.prioritySource])).toEqual([
      [`T${you}`, 'urgent', 'you'],
      [`D${planner}`, 'high', 'planner'],
      [`T${provider}`, 'normal', 'provider'],
      [`D${mine}`, 'low', 'you'],
    ]);
  });

  it('a ticket and a draft without a priority have no source', () => {
    ticket('K1', 'scope');
    insertProposal(store, s1, payload);
    expect(readProjectQueue(store, projectId).entries.map((e) => [e.ownPriority, e.prioritySource])).toEqual([[null, null], [null, null]]);
  });

  it('a Clear of the override lets the provider value order the ticket again', () => {
    const t = ticket('K1', 'scope', ", priority = 'low', priority_override = 'urgent'");
    expect(readProjectQueue(store, projectId).entries[0]).toMatchObject({ ownPriority: 'urgent', prioritySource: 'you' });
    store.db.prepare('UPDATE tickets SET priority_override = NULL WHERE id = ?').run(t);
    expect(readProjectQueue(store, projectId).entries[0]).toMatchObject({ ownPriority: 'low', prioritySource: 'provider' });
  });

  it('names the project provider beside a provider value, and the planner for a planner-written value', () => {
    const fetched = ticket('FET', 'scope', ", priority = 'low', source_ref = 'abc'");
    const planned = ticket('PLN', 'scope', ", priority = 'high', source = 'planning'");
    const byId = (id: number) => readProjectQueue(store, projectId, 'clickup').entries.find((e) => e.id === `T${id}`);
    expect(byId(fetched)).toMatchObject({ prioritySource: 'provider', providerPriority: 'low', providerLabel: 'ClickUp' });
    expect(byId(planned)).toMatchObject({ prioritySource: 'planner', providerPriority: null });
    expect(readProjectQueue(store, projectId).entries.find((e) => e.id === `T${fetched}`)?.providerLabel).toBe('provider');
  });

  it('an override wins over the planner level and drops the reason', () => {
    const d = insertProposal(store, s1, { ...payload, priority: 'urgent', priorityReason: 'data loss' });
    expect(readProjectQueue(store, projectId).entries[0]).toMatchObject({ ownPriority: 'urgent', priorityReason: 'data loss' });
    setProposalPriorityOverride(store, d, 'low');
    expect(readProjectQueue(store, projectId).entries[0]).toMatchObject({ ownPriority: 'low', priorityReason: null });
  });

  it('places a cross-session blocker first and gives it the priority of the draft that waits', () => {
    const blocker = insertProposal(store, s1, { ...payload, title: 'blocker' });
    const urgent = insertProposal(store, s2, { ...payload, priority: 'urgent', dependsOn: [blocker] });
    const q = readProjectQueue(store, projectId);
    expect(q.entries.map((e) => e.id)).toEqual([`D${blocker}`, `D${urgent}`]);
    expect(q.entries[0]).toMatchObject({ priority: 'urgent', inheritedFrom: `D${urgent}` });
    expect(q.entries[1]).toMatchObject({ waitsOn: [`D${blocker}`] });
  });

  it('a draft waits on a scope ticket in the set, and shows a started ticket as an external wait only while it is open', () => {
    const t = ticket('K1', 'scope');
    const running = ticket('RUN', 'impl');
    const finished = ticket('FIN', 'done');
    const d = insertProposal(store, s1, { ...payload, dependsOn: [`T${t}`, `T${running}`, `T${finished}`] });
    const q = readProjectQueue(store, projectId);
    expect(q.entries.map((e) => e.id)).toEqual([`T${t}`, `D${d}`]);
    expect(q.entries[1]!.waitsOn).toEqual([`T${t}`, `T${running}`]);
  });

  it('a ticket waits on a pending draft (in the set) and on a running ticket (external)', () => {
    const d = insertProposal(store, s1, payload);
    const running = ticket('RUN', 'impl');
    const t = ticket('K1', 'scope', ", priority = 'high'");
    addRelation(store, { ticketId: t, kind: 'blocked-by', targetProposalId: d, source: 'agent' });
    addRelation(store, { ticketId: t, kind: 'blocked-by', targetTicketId: running, source: 'user' });
    const q = readProjectQueue(store, projectId);
    expect(q.entries.map((e) => e.id)).toEqual([`D${d}`, `T${t}`]);
    expect(q.entries[0]).toMatchObject({ priority: 'high', inheritedFrom: `T${t}` });
    expect(q.entries[1]!.waitsOn).toEqual([`D${d}`, `T${running}`]);
  });

  it('follows an accepted draft to its ticket and drops a discarded one', () => {
    const accepted = insertProposal(store, s1, payload);
    const own = ticket('OWN', 'impl');
    markProposalAccepted(store, accepted, own);
    const gone = insertProposal(store, s1, payload);
    const d = insertProposal(store, s2, { ...payload, dependsOn: [accepted, gone] });
    discardProposal(store, gone);
    const entry = readProjectQueue(store, projectId).entries.find((e) => e.id === `D${d}`)!;
    expect(entry.waitsOn).toEqual([`T${own}`]);
  });

  it('leaves out other projects, sub-tasks, archived and started tickets', () => {
    const other = upsertProject(store, { slug: 'q' }).id;
    insertProposal(store, createPlanningSession(store, { projectId: other, title: 'o', core: 'claude', model: null }).id, payload);
    const parent = ticket('PAR', 'scope');
    ticket('SUB', 'scope', `, subtask_parent_id = ${parent}`);
    ticket('ARC', 'scope', ", archived_at = datetime('now')");
    ticket('ST', 'impl');
    expect(ids()).toEqual([`T${parent}`]);
  });
});
