import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { upsertProject } from '../store/projects.js';
import { createTicket } from '../store/tickets.js';
import { createPlanningSession } from '../store/planningSessions.js';
import { insertProposal, discardProposal, markProposalAccepted, setProposalPriorityOverride } from '../store/planningProposals.js';
import { addRelation } from '../store/ticketRelations.js';
import { parseQueueArgs, collectQueue, runQueueCommand, QUEUE_TITLE_MAX } from './queueCommand.js';

const payload = { title: 'A draft', description: 'd', summary: 's', repos: ['api'] };

describe('karst queue — parse', () => {
  it('defaults to text and accepts --json', () => {
    expect(parseQueueArgs(['queue'])).toEqual({ json: false });
    expect(parseQueueArgs(['queue', '--json'])).toEqual({ json: true });
  });
  it('rejects a wrong command and an unknown flag', () => {
    expect(() => parseQueueArgs(['blocked'])).toThrow(/queue/);
    expect(() => parseQueueArgs(['queue', '--nope'])).toThrow(/unknown flag/);
  });
});

describe('karst queue — rows', () => {
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

  const atScope = (key: string, extra = ''): number => {
    const t = createTicket(store, { key, title: `title ${key}`, projectId });
    store.db.prepare(`UPDATE tickets SET stage_current = 'scope'${extra} WHERE id = ?`).run(t.id);
    return t.id;
  };

  it('lists pending drafts of every session, then scope tickets, by id', () => {
    const d1 = insertProposal(store, s1, { ...payload, title: 'first' });
    const d2 = insertProposal(store, s2, { ...payload, title: 'second', dependsOn: [d1, 'T9'] });
    const t = atScope('K1');
    expect(collectQueue(store, { projectId })).toEqual([
      { id: `D${d1}`, session: `P${s1}`, title: 'first', priority: null, priorityReason: null, dependsOn: [] },
      { id: `D${d2}`, session: `P${s2}`, title: 'second', priority: null, priorityReason: null, dependsOn: [`D${d1}`, 'T9'] },
      { id: `T${t}`, session: null, title: 'title K1', priority: null, priorityReason: null, dependsOn: [] },
    ]);
  });

  it('carries a draft priority and reason, an override wins and drops the reason, and a ticket shows its own level', () => {
    const planned = insertProposal(store, s1, { ...payload, title: 'planned', priority: 'urgent', priorityReason: 'data loss' });
    const changed = insertProposal(store, s1, { ...payload, title: 'changed', priority: 'urgent', priorityReason: 'data loss' });
    setProposalPriorityOverride(store, changed, 'low');
    const t = atScope('K2', ", priority = 'high'");
    const odd = atScope('K3', ", priority = 'Whenever'");
    const rows = collectQueue(store, { projectId });
    const by = (id: string) => rows.find((r) => r.id === id)!;
    expect(by(`D${planned}`)).toMatchObject({ priority: 'urgent', priorityReason: 'data loss' });
    expect(by(`D${changed}`)).toMatchObject({ priority: 'low', priorityReason: null });
    expect(by(`T${t}`)).toMatchObject({ priority: 'high', priorityReason: null });
    expect(by(`T${odd}`)).toMatchObject({ priority: null });
    const text = runQueueCommand(store, { json: false }, { projectId });
    expect(text).toContain(`D${planned}  P${s1}  urgent  planned  (data loss)`);
    expect(text).toContain(`T${t}  high  title K2`);
  });

  it('leaves out discarded and accepted drafts, other projects, subtasks, archived and started tickets', () => {
    const gone = insertProposal(store, s1, payload);
    discardProposal(store, gone);
    const taken = insertProposal(store, s1, payload);
    const own = createTicket(store, { key: 'OWN', title: 'own', projectId }).id;
    store.db.prepare("UPDATE tickets SET stage_current = 'impl' WHERE id = ?").run(own);
    markProposalAccepted(store, taken, own);
    const other = upsertProject(store, { slug: 'q' }).id;
    insertProposal(store, createPlanningSession(store, { projectId: other, title: 'o', core: 'claude', model: null }).id, payload);
    const parent = atScope('PAR');
    atScope('SUB', `, subtask_parent_id = ${parent}`);
    atScope('ARC', ", archived_at = datetime('now')");
    const started = createTicket(store, { key: 'ST', title: 'st', projectId }).id;
    store.db.prepare("UPDATE tickets SET stage_current = 'impl' WHERE id = ?").run(started);
    expect(collectQueue(store, { projectId }).map((r) => r.id)).toEqual([`T${parent}`]);
  });

  it('shows the open blockers of a ticket', () => {
    const blocker = createTicket(store, { key: 'BLK', title: 'blk', projectId }).id;
    store.db.prepare("UPDATE tickets SET stage_current = 'impl' WHERE id = ?").run(blocker);
    const t = atScope('K2');
    addRelation(store, { ticketId: t, kind: 'blocked-by', targetTicketId: blocker, source: 'user' });
    expect(collectQueue(store, { projectId })[0]).toMatchObject({ id: `T${t}`, dependsOn: ['BLK'] });
  });

  it('cuts a long title to 90 characters', () => {
    insertProposal(store, s1, { ...payload, title: 'x'.repeat(200) });
    const row = collectQueue(store, { projectId })[0]!;
    expect(row.title).toHaveLength(QUEUE_TITLE_MAX);
    expect(row.title.endsWith('…')).toBe(true);
  });

  it('prints text rows and the same rows as JSON, and says so when empty', () => {
    expect(runQueueCommand(store, { json: false }, { projectId })).toMatch(/empty/);
    const d = insertProposal(store, s1, { ...payload, dependsOn: ['T4'] });
    expect(runQueueCommand(store, { json: false }, { projectId })).toBe(`D${d}  P${s1}  A draft  needs T4`);
    expect(JSON.parse(runQueueCommand(store, { json: true }, { projectId }))).toEqual(collectQueue(store, { projectId }));
  });
});
