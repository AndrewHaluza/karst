import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { openStore, type Store } from '../../store/db.js';
import { createTicket, pauseTicket } from '../../store/tickets.js';
import { setStage } from '../../store/stages.js';
import { openShipRun, reconcileShipRuns } from '../../store/shipRuns.js';
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

  it('resumes a stranded ticket whose ship pid is dead', async () => {
    seedStranded(ticketId);
    const runShip = vi.fn(async () => undefined);
    await resumeStrandedShips(deps({ runShip }));
    expect(runShip).toHaveBeenCalledTimes(1);
    expect(runShip).toHaveBeenCalledWith(ticketId);
  });

  it('leaves a paused ticket alone and never resumes it', async () => {
    seedStranded(ticketId, { paused: true });
    const info = vi.fn();
    const runShip = vi.fn(async () => undefined);
    await resumeStrandedShips(deps({ info, runShip }));
    expect(runShip).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(
      `karst: stranded ship for ticket ${ticketId} left alone — the ticket is paused`,
    );
  });

  it('skips a ticket the ship capability guard rejects and still processes the next', async () => {
    const second = createTicket(store, { key: 'T-2', title: 'other', projectId: 1 }).id;
    seedStranded(ticketId);
    seedStranded(second);
    const runShip = vi.fn(async () => undefined);
    const guardCapability = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
    await resumeStrandedShips(deps({ runShip, guardCapability }));
    expect(runShip).toHaveBeenCalledTimes(1);
    expect(runShip).toHaveBeenCalledWith(second);
  });

  it('reports a rejecting resume without letting the rejection escape', async () => {
    seedStranded(ticketId);
    const boom = new Error('boom');
    const runShip = vi.fn(() => Promise.reject(boom));
    const logError = vi.fn();
    const onResumeFailed = vi.fn();
    await expect(resumeStrandedShips(deps({ runShip, logError, onResumeFailed }))).resolves.toBeUndefined();
    await flush();
    expect(logError).toHaveBeenCalledWith('karst: stranded ship resume failed', boom);
    expect(onResumeFailed).toHaveBeenCalledWith(ticketId);
  });

  it('fires no callback when no ship is stranded', async () => {
    const runShip = vi.fn(async () => undefined);
    const info = vi.fn();
    const logError = vi.fn();
    const onResumeFailed = vi.fn();
    await resumeStrandedShips(deps({ runShip, info, logError, onResumeFailed }));
    expect(runShip).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
    expect(logError).not.toHaveBeenCalled();
    expect(onResumeFailed).not.toHaveBeenCalled();
  });

  describe('after the activation reconcile (@arch:SHIP-RESUME)', () => {
    const sweep = (): void => {
      reconcileShipRuns(store, () => false, '2026-09-15T11:00:00.000Z');
    };
    const stageStatus = (): string =>
      (store.db
        .prepare("SELECT status FROM stages WHERE ticket_id = ? AND stage_key = 'ship'")
        .get(ticketId) as { status: string }).status;
    const seedRun = (over: { unattended?: boolean; paused?: boolean }): void => {
      seedStranded(ticketId, { paused: over.paused === true });
      if (over.unattended === true) {
        store.db.prepare('UPDATE ship_runs SET unattended = 1 WHERE ticket_id = ?').run(ticketId);
      }
    };

    it('starts one unattended-path ship for a dead run whose stage reads running', async () => {
      seedRun({});
      sweep();
      const runShip = vi.fn(async () => undefined);
      await resumeStrandedShips(deps({ runShip }));
      expect(runShip).toHaveBeenCalledTimes(1);
      expect(runShip).toHaveBeenCalledWith(ticketId);
    });

    it('parks the stage failed and starts no ship when the dead run was an unattended resume', async () => {
      seedRun({ unattended: true });
      sweep();
      const runShip = vi.fn(async () => undefined);
      await resumeStrandedShips(deps({ runShip }));
      expect(runShip).not.toHaveBeenCalled();
      expect(stageStatus()).toBe('failed');
    });

    it('parks a paused ticket and starts no ship', async () => {
      seedRun({ paused: true });
      sweep();
      const runShip = vi.fn(async () => undefined);
      await resumeStrandedShips(deps({ runShip }));
      expect(runShip).not.toHaveBeenCalled();
      expect(stageStatus()).toBe('failed');
    });

    it('parks the stage failed and starts no ship when the ship capability guard rejects', async () => {
      seedRun({});
      sweep();
      const runShip = vi.fn(async () => undefined);
      await resumeStrandedShips(deps({ runShip, guardCapability: () => false }));
      expect(runShip).not.toHaveBeenCalled();
      expect(stageStatus()).toBe('failed');
    });

    it('parks a dead ship of another project, which this window will never resume', async () => {
      store.db.prepare('INSERT INTO projects (id, slug) VALUES (?, ?)').run(2, 'other');
      seedRun({});
      store.db.prepare('UPDATE tickets SET project_id = 2 WHERE id = ?').run(ticketId);
      sweep();
      const runShip = vi.fn(async () => undefined);
      await resumeStrandedShips(deps({ runShip }));
      expect(runShip).not.toHaveBeenCalled();
      expect(stageStatus()).toBe('failed');
    });
  });
});
