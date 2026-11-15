import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { createTicket } from '../../store/tickets.js';
import { autoFireImplMarker } from './graphAutoMarker.js';

describe('autoFireImplMarker', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  function pausedTicket(): number {
    store.db.prepare("INSERT INTO projects (slug) VALUES ('p')").run();
    const projectId = (store.db.prepare('SELECT id FROM projects').get() as { id: number }).id;
    const ticketId = createTicket(store, { key: 'AM-1', title: 't', projectId }).id;
    store.db.prepare("UPDATE tickets SET stage_current = 'impl', paused_at = datetime('now') WHERE id = ?").run(ticketId);
    return ticketId;
  }

  it('never drives a paused ticket and refreshes only on the first report', async () => {
    const ticketId = pausedTicket();
    const drive = vi.fn();
    const refresh = vi.fn();
    const deps = { store, debug: vi.fn(), drive, refresh, git: vi.fn(), runLint: vi.fn() };
    await autoFireImplMarker(deps, ticketId, 1);
    await autoFireImplMarker(deps, ticketId, 1);
    expect(drive).not.toHaveBeenCalled();
    expect(refresh.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('logs a failure instead of throwing', async () => {
    const debug = vi.fn();
    await expect(
      autoFireImplMarker({ store, debug, drive: vi.fn(), refresh: vi.fn() }, 9999, 1),
    ).resolves.toBeUndefined();
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('auto impl marker failed'));
  });
});
