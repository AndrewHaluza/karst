import { describe, it, expect } from 'vitest';
import {
  validateQuota,
  DEFAULT_QUOTA_WARN_THRESHOLD_PCT,
} from './quota.js';

describe('validateQuota', () => {
  it('defaults the threshold for an absent block', () => {
    expect(validateQuota(undefined)).toEqual({
      warnThresholdPct: DEFAULT_QUOTA_WARN_THRESHOLD_PCT,
    });
    expect(DEFAULT_QUOTA_WARN_THRESHOLD_PCT).toBe(80);
  });
  it('defaults the threshold for an empty block', () => {
    expect(validateQuota({})).toEqual({ warnThresholdPct: 80 });
  });
  it('reads an explicit threshold', () => {
    expect(validateQuota({ warnThresholdPct: 95 })).toEqual({ warnThresholdPct: 95 });
  });
  it('defaults the global statusline install to OFF (absent)', () => {
    expect(validateQuota({ warnThresholdPct: 80 })).not.toHaveProperty('claudeGlobalStatusline');
    expect(validateQuota(undefined)).not.toHaveProperty('claudeGlobalStatusline');
  });
  it('reads the opt-in global Claude statusline flag', () => {
    expect(validateQuota({ claudeGlobalStatusline: true })).toEqual({
      warnThresholdPct: 80,
      claudeGlobalStatusline: true,
    });
    expect(validateQuota({ warnThresholdPct: 95, claudeGlobalStatusline: false })).toEqual({
      warnThresholdPct: 95,
      claudeGlobalStatusline: false,
    });
  });
  it('rejects a non-boolean global statusline flag', () => {
    expect(() => validateQuota({ claudeGlobalStatusline: 'yes' })).toThrow(
      /quota\.claudeGlobalStatusline must be true or false/,
    );
  });
  it('accepts the range bounds', () => {
    expect(validateQuota({ warnThresholdPct: 1 })).toEqual({ warnThresholdPct: 1 });
    expect(validateQuota({ warnThresholdPct: 100 })).toEqual({ warnThresholdPct: 100 });
  });
  it('rejects a threshold outside 1–100', () => {
    expect(() => validateQuota({ warnThresholdPct: 0 })).toThrow(
      /quota\.warnThresholdPct must be a whole number between 1 and 100/,
    );
    expect(() => validateQuota({ warnThresholdPct: 101 })).toThrow(/between 1 and 100/);
  });
  it('rejects a non-integer threshold', () => {
    expect(() => validateQuota({ warnThresholdPct: 80.5 })).toThrow(/whole number/);
    expect(() => validateQuota({ warnThresholdPct: '80' })).toThrow(/whole number/);
  });
  it('rejects unknown keys', () => {
    expect(() => validateQuota({ warnThreshold: 80 })).toThrow(
      /quota\.warnThreshold is not a known setting/,
    );
  });
  it('rejects a non-mapping block', () => {
    expect(() => validateQuota([])).toThrow(/quota must be a mapping/);
    expect(() => validateQuota('80')).toThrow(/quota must be a mapping/);
  });
});
