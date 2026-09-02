import { describe, it, expect } from 'vitest';
import { shouldStartDriver, ticketsToSweep, DriverController } from './driverController.js';

describe('ticketsToSweep', () => {
  const at = (id: number, stageCurrent: string | null) => ({ id, stageCurrent, stages: [] });

  it('selects gate-stage tickets regardless of any open session', () => {
    const tickets = [at(1, 'uat'), at(2, 'review'), at(3, 'impl'), at(4, 'done')];
    expect(ticketsToSweep(tickets)).toEqual([1, 2]);
  });

  it('excludes non-gate stages (impl/scope/ship/fix/done/null)', () => {
    const tickets = [at(1, 'impl'), at(2, 'scope'), at(3, 'ship'), at(4, 'fix'), at(5, 'done'), at(6, null)];
    expect(ticketsToSweep(tickets)).toEqual([]);
  });

  it('excludes paused tickets', () => {
    const tickets = [
      { id: 1, stageCurrent: 'uat', pausedAt: '2026-09-02T12:00:00.000Z', stages: [] },
      { id: 2, stageCurrent: 'review', pausedAt: null, stages: [] },
    ];
    expect(ticketsToSweep(tickets)).toEqual([2]);
  });

  it('returns empty for an empty ticket list', () => {
    expect(ticketsToSweep([])).toEqual([]);
  });
});

describe('ticketsToSweep with blocked stages', () => {
  it('selects a ticket parked at an unblocked gate', () => {
    expect(
      ticketsToSweep([
        { id: 1, stageCurrent: 'uat', stages: [{ stageKey: 'uat', blockedKind: null }] },
      ]),
    ).toEqual([1]);
  });

  it('does NOT select a ticket whose current gate is blocked', () => {
    expect(
      ticketsToSweep([
        { id: 1, stageCurrent: 'uat', stages: [{ stageKey: 'uat', blockedKind: 'nothing-to-run' }] },
      ]),
    ).toEqual([]);
  });

  it('ignores a block recorded on a stage the ticket has moved past', () => {
    expect(
      ticketsToSweep([
        {
          id: 1,
          stageCurrent: 'review',
          stages: [
            { stageKey: 'uat', blockedKind: 'nothing-to-run' },
            { stageKey: 'review', blockedKind: null },
          ],
        },
      ]),
    ).toEqual([1]);
  });
});

describe('shouldStartDriver', () => {
  it('starts on gate stages — the marker is the done signal, an open session does not block', () => {
    expect(shouldStartDriver('uat')).toBe(true);
    expect(shouldStartDriver('review')).toBe(true);
  });
  it('does not start on non-gate stages', () => {
    expect(shouldStartDriver('impl')).toBe(false);
    expect(shouldStartDriver('ship')).toBe(false);
    expect(shouldStartDriver('scope')).toBe(false);
  });
});

describe('DriverController', () => {
  it('begin is single-flight per ticket', () => {
    const c = new DriverController();
    expect(c.begin(1)).toBe(true);
    expect(c.begin(1)).toBe(false); // already running
    c.end(1);
    expect(c.begin(1)).toBe(true);
  });
  it('requestStop makes shouldContinue false until the run ends', () => {
    const c = new DriverController();
    c.begin(1);
    expect(c.shouldContinue(1)).toBe(true);
    c.requestStop(1);
    expect(c.shouldContinue(1)).toBe(false);
    c.end(1);
    c.begin(1);
    expect(c.shouldContinue(1)).toBe(true); // stop flag cleared on new run
  });

  it('requestStop aborts the run signal, so Stop reaches a gate already running', () => {
    const c = new DriverController();
    c.begin(1);
    const signal = c.signalFor(1);
    expect(signal?.aborted).toBe(false);
    c.requestStop(1);
    expect(signal?.aborted).toBe(true);
  });

  it('gives each run a fresh signal, so a stopped run never poisons the next', () => {
    const c = new DriverController();
    c.begin(1);
    const first = c.signalFor(1);
    c.requestStop(1);
    c.end(1);
    c.begin(1);
    const second = c.signalFor(1);
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
    expect(second?.aborted).toBe(false);
  });

  it('has no signal for a ticket with no run in flight', () => {
    const c = new DriverController();
    expect(c.signalFor(1)).toBeUndefined();
    c.begin(1);
    c.end(1);
    expect(c.signalFor(1)).toBeUndefined();
  });
});
