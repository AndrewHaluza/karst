import { describe, expect, it } from 'vitest';
import config from '../../playwright.config.js';
import { FIXTURE_TIMEOUT_MS, WEB_SERVER_TIMEOUT_MS, formatStepTiming } from './serveLimits.mjs';

describe('visual server start limits', () => {
  it('the webServer timeout is the shared constant', () => {
    expect((config.webServer as { timeout: number }).timeout).toBe(WEB_SERVER_TIMEOUT_MS);
  });

  it('the webServer timeout is greater than the fixture step limit', () => {
    expect(WEB_SERVER_TIMEOUT_MS).toBeGreaterThan(FIXTURE_TIMEOUT_MS);
  });

  it('the webServer timeout is 120 s and the fixture limit is 60 s', () => {
    expect(WEB_SERVER_TIMEOUT_MS).toBe(120_000);
    expect(FIXTURE_TIMEOUT_MS).toBe(60_000);
  });

  it('formats one stable timing line per step', () => {
    expect(formatStepTiming('fixtures', 23140)).toBe('visual server: fixtures 23140 ms');
    expect(formatStepTiming('listen', 3.6)).toBe('visual server: listen 4 ms');
  });
});
