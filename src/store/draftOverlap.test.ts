import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from './db.js';
import { upsertProject } from './projects.js';
import { createTicket } from './tickets.js';
import { createPlanningSession } from './planningSessions.js';
import { insertProposal, markProposalAccepted, discardProposal } from './planningProposals.js';
import { addRelation } from './ticketRelations.js';
import { connectedNodes, listOverlapCandidates } from './draftOverlap.js';

describe('connectedNodes', () => {
  it('follows edges in both directions, transitively', () => {
    const edges = new Map([['A', ['B']], ['C', ['B']], ['D', ['E']]]);
    expect([...connectedNodes(edges, 'A')].sort()).toEqual(['A', 'B', 'C']);
    expect([...connectedNodes(edges, 'Z')]).toEqual(['Z']);
  });
});

describe('listOverlapCandidates', () => {
  let store: Store;
  let projectId: number;
  let sessionId: number;
  const payload = (title: string, description = 'd') => ({ title, description, summary: 's', repos: [] });
  beforeEach(() => {
    store = openStore(':memory:');
    projectId = upsertProject(store, { slug: 'p' }).id;
    sessionId = createPlanningSession(store, { projectId, title: 's', core: 'claude', model: null }).id;
  });
  afterEach(() => store.close());

  const refs = (incomingId: number | undefined, deps: (number | `T${number}`)[] = []) =>
    listOverlapCandidates(store, projectId, incomingId, deps).map((c) => c.ref);

  it('lists pending drafts and open tickets of the project with their title and description', () => {
    const d = insertProposal(store, sessionId, payload('Draft one', 'src/a.ts'));
    const t = createTicket(store, { key: 'K', title: 'Ticket one', description: 'src/b.ts', projectId }).id;
    expect(listOverlapCandidates(store, projectId, undefined, [])).toEqual([
      { ref: `D${d}`, title: 'Draft one', description: 'src/a.ts' },
      { ref: `T${t}`, title: 'Ticket one', description: 'src/b.ts' },
    ]);
  });
  it('a ticket with no description reads as empty text', () => {
    const t = createTicket(store, { key: 'K', title: 'T', projectId }).id;
    expect(listOverlapCandidates(store, projectId, undefined, [])).toEqual([{ ref: `T${t}`, title: 'T', description: '' }]);
  });
  it('skips done, closed and archived tickets, other projects and discarded drafts', () => {
    const mk = (key: string, set?: string) => {
      const id = createTicket(store, { key, title: key, projectId }).id;
      if (set) store.db.prepare(`UPDATE tickets SET ${set} WHERE id = ?`).run(id);
      return id;
    };
    const open = mk('OPEN');
    mk('DONE', "stage_current = 'done'");
    mk('CLO', "stage_current = 'closed'");
    mk('ARC', "archived_at = datetime('now')");
    const running = mk('RUN', "stage_current = 'impl'");
    const other = upsertProject(store, { slug: 'q' }).id;
    createTicket(store, { key: 'F', title: 'f', projectId: other });
    const gone = insertProposal(store, sessionId, payload('gone'));
    discardProposal(store, gone);
    expect(refs(undefined)).toEqual([`T${open}`, `T${running}`]);
  });
  it('skips the incoming draft itself', () => {
    const a = insertProposal(store, sessionId, payload('a'));
    const b = insertProposal(store, sessionId, payload('b'));
    expect(refs(a)).toEqual([`D${b}`]);
  });
  it('skips drafts and tickets connected through dependsOn, transitively, both ways', () => {
    const a = insertProposal(store, sessionId, payload('a'));
    const b = insertProposal(store, sessionId, { ...payload('b'), dependsOn: [a] });
    const c = insertProposal(store, sessionId, payload('c'));
    const t = createTicket(store, { key: 'K', title: 'k', projectId }).id;
    // new -> b -> a ; c and t are unrelated
    expect(refs(undefined, [b])).toEqual([`D${c}`, `T${t}`]);
    // the revised c depends on T: T is excluded, a and b stay
    expect(refs(c, [`T${t}`])).toEqual([`D${a}`, `D${b}`]);
  });
  it('skips the ticket of an accepted draft in the chain, and a ticket blocked by the incoming draft', () => {
    const a = insertProposal(store, sessionId, payload('a'));
    const ta = createTicket(store, { key: 'KA', title: 'ta', projectId }).id;
    markProposalAccepted(store, a, ta);
    const x = insertProposal(store, sessionId, payload('x'));
    const tb = createTicket(store, { key: 'KB', title: 'tb', projectId }).id;
    addRelation(store, { ticketId: tb, kind: 'blocked-by', targetProposalId: x, source: 'agent' });
    const free = createTicket(store, { key: 'KF', title: 'free', projectId }).id;
    expect(refs(x, [a])).toEqual([`T${free}`]);
  });
});
