import { describe, expect, it, vi } from 'vitest';
import { openStore } from '../../store/db.js';
import { createTicket } from '../../store/tickets.js';
import { runBridgeSweep } from './bootSweeps.js';

function setup() {
  const store = openStore(':memory:');
  const open = createTicket(store, { key: 'K-1', title: 'o' }).id;
  const done = createTicket(store, { key: 'K-2', title: 'd' }).id;
  store.db.prepare("UPDATE tickets SET stage_current = 'done' WHERE id = ?").run(done);
  return { store, open, info: vi.fn(), logError: vi.fn() };
}

describe('runBridgeSweep', () => {
  it('sweeps once with the open tickets and this window\'s owned set, and reports what it did', async () => {
    const s = setup();
    const owned = new Set([s.open]);
    const sweep = vi.fn(async () => ({ reattached: [s.open, 12], removed: [9, 10] }));
    await runBridgeSweep({ store: s.store, bridges: { sweep }, owned, info: s.info, logError: s.logError });
    expect(sweep).toHaveBeenCalledTimes(1);
    expect(sweep).toHaveBeenCalledWith(new Set([s.open]), owned);
    expect(s.info).toHaveBeenCalledWith(`karst: re-attached sandbox evidence bridge(s) for ticket(s) ${s.open}, 12`);
    expect(s.info).toHaveBeenCalledWith('karst: removed sandbox evidence bridge(s) of closed ticket(s) 9, 10');
    expect(s.logError).not.toHaveBeenCalled();
  });

  it('is silent when there is nothing to report', async () => {
    const s = setup();
    await runBridgeSweep({ store: s.store, bridges: { sweep: async () => ({ reattached: [], removed: [] }) }, owned: new Set(), info: s.info, logError: s.logError });
    expect(s.info).not.toHaveBeenCalled();
  });

  it('a rejected sweep is logged, never thrown', async () => {
    const s = setup();
    const err = new Error('boom');
    await expect(
      runBridgeSweep({ store: s.store, bridges: { sweep: () => Promise.reject(err) }, owned: new Set(), info: s.info, logError: s.logError }),
    ).resolves.toBeUndefined();
    expect(s.logError).toHaveBeenCalledWith('karst: sandbox bridge sweep failed', err);
  });
});
