import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { upsertProject } from '../../store/projects.js';
import { createTicket, getTicket, setStageCurrent, archiveTicket } from '../../store/tickets.js';
import { setTicketPriorityOp, type TicketPriorityDeps } from './ticketPriorityOps.js';

describe('setTicketPriorityOp', () => {
  let store: Store;
  let projectId: number;
  let errors: string[];
  let changes: number;
  const deps = (over: Partial<TicketPriorityDeps> = {}): TicketPriorityDeps => ({
    store,
    projectId: () => projectId,
    notify: { info: () => {}, warn: () => {}, error: async (m) => { errors.push(m); } },
    onChange: () => { changes += 1; },
    ...over,
  });
  const scoped = () => {
    const t = createTicket(store, { key: 'K', title: 'T', projectId });
    setStageCurrent(store, t.id, 'scope');
    return t;
  };

  beforeEach(() => {
    store = openStore(':memory:');
    projectId = upsertProject(store, { slug: 'p' }).id;
    errors = [];
    changes = 0;
  });
  afterEach(() => store.close());

  it('sets then clears the priority of a top-level ticket at scope', async () => {
    const t = scoped();
    await setTicketPriorityOp(deps(), t.id, 'high');
    expect(getTicket(store, t.id).priority).toBe('high');
    await setTicketPriorityOp(deps(), t.id, null);
    expect(getTicket(store, t.id).priority).toBeNull();
    expect(changes).toBe(2);
    expect(errors).toEqual([]);
  });

  it('refuses an unknown ticket, a foreign project, a started, an archived and a sub-task ticket', async () => {
    const t = scoped();
    const started = createTicket(store, { key: 'S', title: 'S', projectId });
    setStageCurrent(store, started.id, 'impl');
    const archived = scoped2('A');
    archiveTicket(store, archived.id);
    const child = createTicket(store, { key: 'C', title: 'C', projectId, subtaskParentId: t.id });
    setStageCurrent(store, child.id, 'scope');
    await setTicketPriorityOp(deps(), 99999, 'low');
    await setTicketPriorityOp(deps({ projectId: () => projectId + 1 }), t.id, 'low');
    await setTicketPriorityOp(deps(), started.id, 'low');
    await setTicketPriorityOp(deps(), archived.id, 'low');
    await setTicketPriorityOp(deps(), child.id, 'low');
    expect(errors).toHaveLength(5);
    expect(errors[2]).toContain('has left scope');
    expect(errors[3]).toContain('archived');
    expect(errors[4]).toContain('sub-task');
    expect([t, started, archived, child].map((x) => getTicket(store, x.id).priority)).toEqual([null, null, null, null]);
    expect(changes).toBe(0);
  });

  function scoped2(key: string) {
    const t = createTicket(store, { key, title: key, projectId });
    setStageCurrent(store, t.id, 'scope');
    return t;
  }
});
