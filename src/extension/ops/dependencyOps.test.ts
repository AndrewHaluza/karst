import { describe, it, expect, vi, beforeEach } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { upsertProject } from '../../store/projects.js';
import { createTicket } from '../../store/tickets.js';
import { addRelation } from '../../store/ticketRelations.js';
import { makeDependencyOps } from './dependencyOps.js';

let store: Store;
let projectId: number;

describe('dependencyOps', () => {
  beforeEach(() => {
    store = openStore(':memory:');
    projectId = upsertProject(store, { slug: 'p' }).id;
  });

  it('opens the dashboard when two tickets are related', () => {
    const ticketA = createTicket(store, { key: 'P-1', title: 'A', projectId }).id;
    const ticketB = createTicket(store, { key: 'P-2', title: 'B', projectId }).id;

    addRelation(store, { ticketId: ticketA, kind: 'blocked-by', targetTicketId: ticketB, source: 'user' });

    const openDashboard = vi.fn();
    const ops = makeDependencyOps(store, { openDashboard });

    ops.openDependency(ticketA, ticketB);
    expect(openDashboard).toHaveBeenCalledWith(ticketB);
  });

  it('does not open dashboard when tickets are not related', () => {
    const ticketA = createTicket(store, { key: 'P-1', title: 'A', projectId }).id;
    const ticketB = createTicket(store, { key: 'P-2', title: 'B', projectId }).id;

    const openDashboard = vi.fn();
    const ops = makeDependencyOps(store, { openDashboard });

    ops.openDependency(ticketA, ticketB);
    expect(openDashboard).not.toHaveBeenCalled();
  });

  it('opens dashboard when relation is in reverse direction', () => {
    const ticketA = createTicket(store, { key: 'P-1', title: 'A', projectId }).id;
    const ticketB = createTicket(store, { key: 'P-2', title: 'B', projectId }).id;

    addRelation(store, { ticketId: ticketB, kind: 'parent', targetTicketId: ticketA, source: 'user' });

    const openDashboard = vi.fn();
    const ops = makeDependencyOps(store, { openDashboard });

    ops.openDependency(ticketA, ticketB);
    expect(openDashboard).toHaveBeenCalledWith(ticketB);
  });

  it('opens dashboard when either blocked-by or parent relation exists', () => {
    const ticketA = createTicket(store, { key: 'P-1', title: 'A', projectId }).id;
    const ticketB = createTicket(store, { key: 'P-2', title: 'B', projectId }).id;

    addRelation(store, { ticketId: ticketA, kind: 'parent', targetTicketId: ticketB, source: 'user' });

    const openDashboard = vi.fn();
    const ops = makeDependencyOps(store, { openDashboard });

    ops.openDependency(ticketA, ticketB);
    expect(openDashboard).toHaveBeenCalledWith(ticketB);
  });
});
