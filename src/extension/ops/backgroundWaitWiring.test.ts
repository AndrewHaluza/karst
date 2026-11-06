import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { createTicket, getTicket } from '../../store/tickets.js';
import { openImplementationRun } from '../../store/implementationRuns.js';
import { BACKGROUND_WAIT_DEFAULT_MS, BACKGROUND_WAIT_SWEEP_INTERVAL_MS, TurnTracker } from '../../hooks/dispatch.js';
import { startBackgroundWaitSweep } from './backgroundWaitWiring.js';

describe('startBackgroundWaitSweep', () => {
  let store: Store;
  beforeEach(() => {
    vi.useFakeTimers();
    store = openStore(':memory:');
  });
  afterEach(() => {
    store.close();
    vi.useRealTimers();
  });

  function ticketInWait(tracker: TurnTracker): number {
    const t = createTicket(store, { key: 'W', title: 'w' });
    openImplementationRun(store, { ticketId: t.id, attempt: 0, provider: 'claude', startedAt: '2026-11-06T13:59:00.000Z' });
    store.db.prepare("UPDATE tickets SET agent_state = 'running' WHERE id = ?").run(t.id);
    tracker.extendBackgroundWait(t.id, BACKGROUND_WAIT_DEFAULT_MS);
    tracker.markWaitQuiet(t.id);
    return t.id;
  }

  it('flips a quiet expired wait to waiting, notifies, and stops on dispose', () => {
    const tracker = new TurnTracker();
    const id = ticketInWait(tracker);
    const notify = vi.fn();
    const sweep = startBackgroundWaitSweep(store, tracker, notify, vi.fn());
    vi.advanceTimersByTime(BACKGROUND_WAIT_DEFAULT_MS + BACKGROUND_WAIT_SWEEP_INTERVAL_MS);
    expect(getTicket(store, id).agentState).toBe('waiting');
    expect(notify).toHaveBeenCalledTimes(1);
    sweep.dispose();
    const second = ticketInWait(tracker);
    vi.advanceTimersByTime(BACKGROUND_WAIT_DEFAULT_MS + BACKGROUND_WAIT_SWEEP_INTERVAL_MS);
    expect(getTicket(store, second).agentState).toBe('running');
  });

  it('logs a failing sweep and keeps the timer running', () => {
    const tracker = new TurnTracker();
    const debug = vi.fn();
    const spy = vi.spyOn(tracker, 'takeExpiredWaits').mockImplementation(() => {
      throw new Error('boom');
    });
    const sweep = startBackgroundWaitSweep(store, tracker, vi.fn(), debug);
    vi.advanceTimersByTime(BACKGROUND_WAIT_SWEEP_INTERVAL_MS * 2);
    expect(debug).toHaveBeenCalledTimes(2);
    expect(debug.mock.calls[0]![0]).toContain('boom');
    spy.mockRestore();
    sweep.dispose();
  });
});
