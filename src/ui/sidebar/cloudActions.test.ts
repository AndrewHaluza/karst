import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { createTicket } from '../../store/tickets.js';
import { listCloudSessionLinks } from '../../store/cloudSessionLinks.js';
import { makeCloudSidebarActions } from './cloudActions.js';

const URL1 = 'https://claude.ai/code/session_abc';

describe('makeCloudSidebarActions', () => {
  let store: Store;
  beforeEach(() => {
    store = openStore(':memory:');
    store.db.prepare("INSERT INTO projects (id, slug) VALUES (1, 'p')").run();
  });
  afterEach(() => store.close());
  function setup(projectId: number | null = 1, entered: string | undefined = undefined) {
    const notify = { info: vi.fn(), warn: vi.fn(), error: vi.fn(async () => {}) };
    const openExternal = vi.fn(async () => true);
    const refresh = vi.fn();
    const actions = makeCloudSidebarActions({ store, projectId: () => projectId ?? undefined, notify, openExternal, promptUrl: async () => entered, refresh });
    return { actions, notify, openExternal, refresh };
  }

  it('opens a valid session externally and rejects a bad url so the control settles as failed', async () => {
    const { actions, openExternal } = setup();
    await actions.cloudSessionOpen(URL1);
    expect(openExternal).toHaveBeenCalledWith(URL1);
    await expect(actions.cloudSessionOpen('https://evil.example/x')).rejects.toThrow();
    expect(openExternal).toHaveBeenCalledOnce();
  });

  it('links to a ticket, unlinks, and refreshes the sidebar after each', () => {
    const t = createTicket(store, { key: 'A-1', title: 'a', projectId: 1 });
    const { actions, refresh } = setup();
    actions.cloudSessionLink(URL1, { ticketId: t.id });
    expect(listCloudSessionLinks(store, { projectId: 1 })[0]).toMatchObject({ ticketId: t.id, linkSource: 'manual' });
    actions.cloudSessionUnlink(URL1);
    expect(listCloudSessionLinks(store, { projectId: 1 })[0]!.ticketId).toBeNull();
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('add: a pasted url links by hand; a second link of the same provider adds a row; bad url warns; cancel is a no-op', async () => {
    const t = createTicket(store, { key: 'A-1', title: 'a', projectId: 1 });
    const first = setup(1, URL1);
    await first.actions.cloudSessionAdd({ ticketId: t.id });
    await setup(1, `${URL1}2`).actions.cloudSessionAdd({ ticketId: t.id });
    expect(listCloudSessionLinks(store, { projectId: 1 }).map((r) => [r.url, r.ticketId, r.linkSource])).toEqual([
      [URL1, t.id, 'manual'],
      [`${URL1}2`, t.id, 'manual'],
    ]);
    const bad = setup(1, 'https://evil.example/x');
    await expect(bad.actions.cloudSessionAdd({ ticketId: t.id })).rejects.toThrow();
    expect(bad.notify.warn).toHaveBeenCalledWith('Not a recognised cloud session URL.');
    const cancelled = setup(1, undefined);
    await cancelled.actions.cloudSessionAdd({ ticketId: t.id });
    expect(cancelled.refresh).not.toHaveBeenCalled();
    expect(listCloudSessionLinks(store, { projectId: 1 })).toHaveLength(2);
  });

  it('throws (no refresh) when the op refuses, and when no project is bound', () => {
    const { actions, refresh, notify } = setup();
    expect(() => actions.cloudSessionLink(URL1, { ticketId: 999 })).toThrow();
    expect(notify.warn).toHaveBeenCalled();
    expect(() => actions.cloudSessionUnlink('nope')).toThrow();
    expect(refresh).not.toHaveBeenCalled();
    const none = setup(null);
    expect(() => none.actions.cloudSessionUnlink(URL1)).toThrow(/project/i);
  });
});
