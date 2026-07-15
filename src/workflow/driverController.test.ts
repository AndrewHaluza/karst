import { describe, it, expect } from 'vitest';
import { shouldStartDriver, ticketsToSweep, DriverController } from './driverController.js';

describe('ticketsToSweep', () => {
  const at = (id: number, stageCurrent: string | null) => ({ id, stageCurrent });

  it('selects gate-stage tickets with no live session', () => {
    const tickets = [at(1, 'uat'), at(2, 'review'), at(3, 'impl'), at(4, 'done')];
    expect(ticketsToSweep(tickets, () => false)).toEqual([1, 2]);
  });

  it('excludes gate tickets that have a live session', () => {
    const tickets = [at(1, 'uat'), at(2, 'review')];
    // session open only for ticket 1
    expect(ticketsToSweep(tickets, (id) => id === 1)).toEqual([2]);
  });

  it('excludes non-gate stages (impl/scope/ship/fix/done/null)', () => {
    const tickets = [at(1, 'impl'), at(2, 'scope'), at(3, 'ship'), at(4, 'fix'), at(5, 'done'), at(6, null)];
    expect(ticketsToSweep(tickets, () => false)).toEqual([]);
  });

  it('returns empty for an empty ticket list', () => {
    expect(ticketsToSweep([], () => false)).toEqual([]);
  });
});

describe('shouldStartDriver', () => {
  it('starts on gate stages with no live session', () => {
    expect(shouldStartDriver('uat', false)).toBe(true);
    expect(shouldStartDriver('review', false)).toBe(true);
  });
  it('does not start with a live session or on non-gate stages', () => {
    expect(shouldStartDriver('uat', true)).toBe(false);
    expect(shouldStartDriver('impl', false)).toBe(false);
    expect(shouldStartDriver('ship', false)).toBe(false);
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
});
