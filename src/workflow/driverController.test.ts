import { describe, it, expect } from 'vitest';
import { shouldStartDriver, DriverController } from './driverController.js';

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
