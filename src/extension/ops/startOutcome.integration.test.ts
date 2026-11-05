import { afterEach, describe, expect, it, vi } from 'vitest';
import { openStore } from '../../store/db.js';
import { createTicket, getTicket, setAgentState } from '../../store/tickets.js';
import { settleStartOutcome, withBackendTimeout, type SessionOutcome } from './startOutcome.js';

type Mode = 'succeeds' | 'fails' | 'never';

/** The pre-launch step of `karst.openSession`, reduced to its outcome contract. */
async function openSessionLike(mode: Mode, launched: number[], id: number, ms: number): Promise<SessionOutcome> {
  try {
    const step = await withBackendTimeout(
      () => (mode === 'never' ? new Promise<string>(() => {}) : mode === 'fails' ? Promise.reject(new Error('sbx failed')) : Promise.resolve('sbx')),
      ms,
      () => {},
    );
    if (step.kind === 'timed-out') return { kind: 'failed', reason: 'backend timeout' };
    launched.push(id);
    return { kind: 'launched' };
  } catch (e) {
    return { kind: 'failed', reason: e instanceof Error ? e.message : String(e) };
  }
}

describe('4 concurrent starts', () => {
  afterEach(() => vi.useRealTimers());

  it('each ticket ends launched or not-started, with a log line for each loss', async () => {
    vi.useFakeTimers();
    const store = openStore(':memory:');
    const modes: Mode[] = ['succeeds', 'fails', 'never', 'succeeds'];
    const ids = modes.map((_, i) => createTicket(store, { key: `T${i}`, title: `t${i}` }).id);
    const launched: number[] = [];
    const log = vi.fn<(m: string) => void>();
    const results = Promise.all(
      ids.map(async (id, i) => {
        const outcome = await openSessionLike(modes[i]!, launched, id, 1000);
        return settleStartOutcome({ ticketId: id, outcome, log, markNotStarted: (t) => setAgentState(store, t, 'not-started') });
      }),
    );
    await vi.advanceTimersByTimeAsync(1000);
    const res = await results;
    expect(res.map((r) => r.ok)).toEqual([true, false, false, true]);
    expect(launched).toEqual([ids[0], ids[3]]);
    expect(ids.map((id) => getTicket(store, id).agentState)).toEqual(['none', 'not-started', 'not-started', 'none']);
    expect(log).toHaveBeenCalledTimes(2);
  });
});
