import { describe, expect, it, vi } from 'vitest';
import { reapOrphanedChildren, recordSpawnedChild, bindOrphanReap } from './orphanReap.js';
import { openStore } from '../../store/db.js';
import { createTicket } from '../../store/tickets.js';
import { openProcessRun, getProcessRunById } from '../../store/processRuns.js';
import type { ProcessRun } from '../../store/processRuns.js';

const SPAWNED = '2026-11-07T10:00:00.000Z';
const run = (id: number, over: Partial<ProcessRun> = {}): ProcessRun =>
  ({ id, pid: 111, childPid: 200 + id, childStartedAt: SPAWNED, status: 'stale', ...over }) as ProcessRun;

const facts = (alive: number[]) => ({
  isAlive: async (pid: number) => alive.includes(pid),
  processStartMs: async () => Date.parse(SPAWNED),
});

describe('reapOrphanedChildren', () => {
  it('kills the group of a stale run with a dead owner (fake child)', async () => {
    const kill = vi.fn(() => 'killed' as const);
    const debug = vi.fn();
    await reapOrphanedChildren([run(1)], { debug, logError: vi.fn(), facts: facts([201]), kill });
    expect(kill).toHaveBeenCalledExactlyOnceWith(201);
    expect(debug).toHaveBeenCalledTimes(1);
  });

  it('signals nothing for a live owner, and logs one refusal', async () => {
    const kill = vi.fn(() => 'killed' as const);
    const debug = vi.fn();
    await reapOrphanedChildren([run(1)], { debug, logError: vi.fn(), facts: facts([111, 201]), kill });
    expect(kill).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledTimes(1);
  });

  it('signals nothing for a null child pid', async () => {
    const kill = vi.fn(() => 'killed' as const);
    await reapOrphanedChildren([run(1, { childPid: null })], {
      debug: vi.fn(), logError: vi.fn(), facts: facts([]), kill,
    });
    expect(kill).not.toHaveBeenCalled();
  });

  it('isolates a probe fault: logs it and still reaps the next run', async () => {
    const kill = vi.fn(() => 'killed' as const);
    const logError = vi.fn();
    let first = true;
    const flaky = {
      ...facts([202]),
      isAlive: async (pid: number) => {
        if (first) { first = false; throw new Error('boom'); }
        return pid === 202;
      },
    };
    await reapOrphanedChildren([run(1), run(2)], { debug: vi.fn(), logError, facts: flaky, kill });
    expect(logError).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledExactlyOnceWith(202);
  });
});

describe('recordSpawnedChild / bindOrphanReap', () => {
  const setup = () => {
    const store = openStore(':memory:');
    const ticketId = createTicket(store, { key: 'T-1', title: 't' }).id;
    const open = () =>
      openProcessRun(store, {
        ticketId, stageKey: 'review', processId: 'review', attempt: 0,
        pid: 111, startedAt: SPAWNED,
      });
    return { store, open };
  };

  it('records the child on the tracked run', () => {
    const { store, open } = setup();
    const r = open();
    recordSpawnedChild(store, { callSite: 'review-findings', processRunId: r.id } as never, 55, vi.fn(), () => SPAWNED);
    const read = getProcessRunById(store, r.id)!;
    expect([read.childPid, read.childStartedAt, read.pid]).toEqual([55, SPAWNED, 111]);
  });

  it('records nothing without a process run id', () => {
    const { store, open } = setup();
    const r = open();
    recordSpawnedChild(store, { callSite: 'x' } as never, 55, vi.fn());
    recordSpawnedChild(store, undefined, 55, vi.fn());
    expect(getProcessRunById(store, r.id)!.childPid).toBeNull();
  });

  it('reaps the child of a run a new open superseded (dead owner)', async () => {
    const { store, open } = setup();
    const old = open();
    recordSpawnedChild(store, { processRunId: old.id } as never, 222, vi.fn(), () => SPAWNED);
    const kill = vi.fn(() => 'killed' as const);
    const unbind = bindOrphanReap(store, { debug: vi.fn(), logError: vi.fn(), facts: facts([222]), kill });
    open();
    await vi.waitFor(() => expect(kill).toHaveBeenCalledExactlyOnceWith(222));
    unbind();
  });
});
