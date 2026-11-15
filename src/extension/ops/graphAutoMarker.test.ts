import { describe, it, expect, vi } from 'vitest';
import { openStore } from '../../store/db.js';
import { createTicket } from '../../store/tickets.js';
import { autoFireImplMarker } from './graphAutoMarker.js';

describe('autoFireImplMarker', () => {
  it('logs a refusal once, never drives, and always refreshes', () => {
    const store = openStore(':memory:');
    store.db.prepare("INSERT INTO projects (slug) VALUES ('p')").run();
    const projectId = (store.db.prepare("SELECT id FROM projects").get() as { id: number }).id;
    const ticketId = createTicket(store, { key: 'AM-1', title: 't', projectId }).id;
    store.db.prepare("UPDATE tickets SET paused_at = datetime('now') WHERE id = ?").run(ticketId);
    const debug = vi.fn();
    const drive = vi.fn();
    const refresh = vi.fn();
    autoFireImplMarker({ store, debug, drive, refresh }, ticketId, 1);
    expect(drive).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledWith(ticketId);
    store.close();
  });
});
