import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { createTicket, getTicket, updateTicketFields } from '../../store/tickets.js';
import { createSubtaskOp, type LifecycleOpsDeps } from './lifecycleOps.js';

describe('createSubtaskOp (dashboard Add sub-task)', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  function deps(): LifecycleOpsDeps {
    return {
      store,
      notify: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      log: { debug: vi.fn(), warn: vi.fn() },
      confirm: vi.fn(),
      deleteDeps: {} as LifecycleOpsDeps['deleteDeps'],
      openEdit: vi.fn(),
      refresh: vi.fn(),
      reloadManifest: vi.fn().mockResolvedValue(undefined),
      projectId: () => undefined,
      labelTemplate: () => undefined,
      git: vi.fn(),
      manifest: () => undefined,
    } as unknown as LifecycleOpsDeps;
  }

  it('creates the sub-task NOT queued: it waits until its edit form is saved', async () => {
    const parent = createTicket(store, { key: 'P-1', title: 'p' });
    updateTicketFields(store, parent.id, { selectedRepos: ['web'] });
    const d = deps();
    await createSubtaskOp(d, parent.id, { title: 'piece', blocking: false });
    const childId = vi.mocked(d.openEdit).mock.calls[0]![0];
    expect(getTicket(store, childId).autostartPending).toBe(false);
  });
});
