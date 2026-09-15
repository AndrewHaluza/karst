import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { openStore, type Store } from '../../store/db.js';
import { createTicket, pauseTicket } from '../../store/tickets.js';
import { setStage } from '../../store/stages.js';
import { openShipRun } from '../../store/shipRuns.js';
import { resumeStrandedShips, type StrandedShipDeps } from './strandedShip.js';

/** Let the deliberately un-awaited `runShip` rejection settle. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('resumeStrandedShips', () => {
  let store: Store;
  let ticketId: number;

  beforeEach(() => {
    store = openStore(':memory:');
    store.db.prepare('INSERT INTO projects (id, slug) VALUES (?, ?)').run(1, 'karst');
    ticketId = createTicket(store, { key: 'T-1', title: 't', projectId: 1 }).id;
  });
  afterEach(() => store.close());

  const seedStranded = (id: number, over: { pid?: number | null; paused?: boolean } = {}): void => {
    setStage(store, id, 'ship', {
      status: 'running',
      startedAt: '2026-09-15T10:00:00.000Z',
    });
    store.db.prepare("UPDATE tickets SET stage_current = 'ship' WHERE id = ?").run(id);
    openShipRun(store, {
      ticketId: id,
      attempt: 1,
      startedAt: '2026-09-15T10:00:00.000Z',
      pid: over.pid ?? 4242,
    });
    if (over.paused === true) pauseTicket(store, id);
  };

  const deps = (over: Partial<StrandedShipDeps> = {}): StrandedShipDeps => ({
    store,
    projectId: 1,
    isAlive: () => false,
    guardCapability: () => true,
    runShip: vi.fn(async () => undefined),
    info: vi.fn(),
    logError: vi.fn(),
    onResumeFailed: vi.fn(),
    ...over,
  });

  it('resumes a stranded ticket whose ship pid is dead', () => {
    seedStranded(ticketId);
    const runShip = vi.fn(async () => undefined);
    resumeStrandedShips(deps({ runShip }));
    expect(runShip).toHaveBeenCalledTimes(1);
    expect(runShip).toHaveBeenCalledWith(ticketId);
  });

  it('leaves a paused ticket alone and never resumes it', () => {
    seedStranded(ticketId, { paused: true });
    const info = vi.fn();
    const runShip = vi.fn(async () => undefined);
    resumeStrandedShips(deps({ info, runShip }));
    expect(runShip).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(
      `karst: stranded ship for ticket ${ticketId} left alone — the ticket is paused`,
    );
  });

  it('skips a ticket the ship capability guard rejects and still processes the next', () => {
    const second = createTicket(store, { key: 'T-2', title: 'other', projectId: 1 }).id;
    seedStranded(ticketId);
    seedStranded(second);
    const runShip = vi.fn(async () => undefined);
    const guardCapability = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
    resumeStrandedShips(deps({ runShip, guardCapability }));
    expect(runShip).toHaveBeenCalledTimes(1);
    expect(runShip).toHaveBeenCalledWith(second);
  });

  it('reports a rejecting resume without letting the rejection escape', async () => {
    seedStranded(ticketId);
    const boom = new Error('boom');
    const runShip = vi.fn(() => Promise.reject(boom));
    const logError = vi.fn();
    const onResumeFailed = vi.fn();
    expect(() => resumeStrandedShips(deps({ runShip, logError, onResumeFailed }))).not.toThrow();
    await flush();
    expect(logError).toHaveBeenCalledWith('karst: stranded ship resume failed', boom);
    expect(onResumeFailed).toHaveBeenCalledWith(ticketId);
  });

  it('fires no callback when no ship is stranded', () => {
    const runShip = vi.fn(async () => undefined);
    const info = vi.fn();
    const logError = vi.fn();
    const onResumeFailed = vi.fn();
    resumeStrandedShips(deps({ runShip, info, logError, onResumeFailed }));
    expect(runShip).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
    expect(logError).not.toHaveBeenCalled();
    expect(onResumeFailed).not.toHaveBeenCalled();
  });
});
