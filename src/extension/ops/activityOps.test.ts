import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { upsertProject } from '../../store/projects.js';
import { createTicket } from '../../store/tickets.js';
import { listEvents, recordEvent, unreadEventCount } from '../../store/karstEvents.js';
import { makeActivityActions } from './activityOps.js';

describe('activity ops', () => {
  let store: Store;
  let projectId: number;
  let otherId: number;
  let ticketId: number;
  const openDashboard = vi.fn();
  const refresh = vi.fn();
  const showMore = vi.fn();
  const debug = (): void => undefined;
  const make = (pid: () => number | undefined = () => projectId) =>
    makeActivityActions({ store, projectId: pid, openDashboard, refresh, showMore });
  const add = (pid: number, tid?: number) =>
    recordEvent(store, { projectId: pid, level: 'info', source: 'host', title: 't', ...(tid === undefined ? {} : { ticketId: tid }) }, debug)!;

  beforeEach(() => {
    vi.clearAllMocks();
    store = openStore(':memory:');
    projectId = upsertProject(store, { slug: 'p1' }).id;
    otherId = upsertProject(store, { slug: 'p2' }).id;
    ticketId = createTicket(store, { key: 'A-1', projectId, title: 'x' }).id;
  });
  afterEach(() => store.close());

  it('open marks the row read, refreshes and opens the ticket dashboard', async () => {
    const id = add(projectId, ticketId);
    await make().activityOpen(id);
    expect(unreadEventCount(store, projectId)).toBe(0);
    expect(refresh).toHaveBeenCalled();
    expect(openDashboard).toHaveBeenCalledWith(ticketId);
  });

  it('open does nothing for a row without a ticket', async () => {
    const id = add(projectId);
    await make().activityOpen(id);
    expect(unreadEventCount(store, projectId)).toBe(1);
    expect(openDashboard).not.toHaveBeenCalled();
  });

  it('refuses an unknown id, another project\'s id and an unbound window', async () => {
    const foreign = add(otherId);
    await make().activityOpen(99999);
    make().activityMarkRead(foreign);
    make(() => undefined).activityMarkRead(foreign);
    make(() => undefined).activityMarkAllRead();
    expect(unreadEventCount(store, otherId)).toBe(1);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('mark read marks one row only', () => {
    const a = add(projectId);
    add(projectId);
    make().activityMarkRead(a);
    expect(unreadEventCount(store, projectId)).toBe(1);
    expect(listEvents(store, { projectId, limit: 5 }).find((e) => e.id === a)!.readAt).not.toBeNull();
  });

  it('mark all read clears this project and leaves the other', () => {
    add(projectId);
    add(otherId);
    make().activityMarkAllRead();
    expect(unreadEventCount(store, projectId)).toBe(0);
    expect(unreadEventCount(store, otherId)).toBe(1);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('more passes the cursor to the manager', () => {
    make().activityMore(7);
    expect(showMore).toHaveBeenCalledWith(7);
  });
});
