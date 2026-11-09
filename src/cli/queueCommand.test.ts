import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { upsertProject } from '../store/projects.js';
import { createTicket } from '../store/tickets.js';
import { createPlanningSession } from '../store/planningSessions.js';
import { insertProposal } from '../store/planningProposals.js';
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

describe('karst queue — output', () => {
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

  it('says so when the queue is empty', () => {
    expect(runQueueCommand(store, { json: false }, { projectId })).toMatch(/empty/);
    expect(JSON.parse(runQueueCommand(store, { json: true }, { projectId }))).toEqual([]);
  });

  it('prints the computed order as a table with the reason and a footer', () => {
    const blocker = insertProposal(store, s1, { ...payload, title: 'blocker' });
    const urgent = insertProposal(store, s2, { ...payload, title: 'urgent one', priority: 'urgent', dependsOn: [blocker] });
    const t = createTicket(store, { key: 'K1', title: 'a ticket', projectId });
    store.db.prepare("UPDATE tickets SET stage_current = 'scope' WHERE id = ?").run(t.id);
    expect(runQueueCommand(store, { json: false }, { projectId }).split('\n')).toEqual([
      '#  ID  SESSION  PRIO    TITLE       WHY',
      `1  D${blocker}  P${s1}       urgent  blocker     ↑ from D${urgent}`,
      `2  D${urgent}  P${s2}       urgent  urgent one  waits on D${blocker}`,
      `3  T${t.id}  -        normal  a ticket`,
      '3 items · 2 drafts in 2 sessions · 1 tickets',
    ]);
  });

  it('prints the same rows with their reasons as JSON', () => {
    const blocker = insertProposal(store, s1, { ...payload, priorityReason: undefined });
    const urgent = insertProposal(store, s2, { ...payload, priority: 'urgent', priorityReason: 'data loss', dependsOn: [blocker] });
    const rows = JSON.parse(runQueueCommand(store, { json: true }, { projectId }));
    expect(rows).toEqual(collectQueue(store, { projectId }));
    expect(rows[0]).toMatchObject({ position: 1, id: `D${blocker}`, session: `P${s1}`, priority: 'urgent', inheritedFrom: `D${urgent}`, waitsOn: [], cycle: false, why: `↑ from D${urgent}` });
    expect(rows[1]).toMatchObject({ position: 2, priorityReason: 'data loss', waitsOn: [`D${blocker}`], why: `waits on D${blocker}` });
  });

  it('cuts a long title to 90 characters', () => {
    insertProposal(store, s1, { ...payload, title: 'x'.repeat(200) });
    const row = collectQueue(store, { projectId })[0]!;
    expect(row.title).toHaveLength(QUEUE_TITLE_MAX);
    expect(row.title.endsWith('…')).toBe(true);
  });
});
