import { describe, it, expect } from 'vitest';
import {
  countFixAttempts,
  lastFailedGate,
  fixAttemptsRemain,
  capForGate,
  FIX_ATTEMPT_CAP,
} from './fixAttempts.js';

describe('countFixAttempts', () => {
  it('counts one gate stage only', () => {
    const stages = [
      { stageKey: 'uat', attempt: 1 },
      { stageKey: 'review', attempt: 2 },
    ];
    expect(countFixAttempts(stages, 'uat')).toBe(1);
    expect(countFixAttempts(stages, 'review')).toBe(2);
  });

  // This is the test that fails against today's code, which is the point.
  it('interleaved uat and review failures never move each other counter', () => {
    const stages = [
      { stageKey: 'uat', attempt: 2 },
      { stageKey: 'review', attempt: 2 },
    ];
    expect(countFixAttempts(stages, 'uat')).toBe(2);
    expect(fixAttemptsRemain(countFixAttempts(stages, 'uat'))).toBe(true);
    // Summed, this would be 4 — over the cap of 3 — and UAT would be parked with
    // an attempt it had never spent.
    expect(countFixAttempts(stages, 'uat') + countFixAttempts(stages, 'review')).toBe(4);
  });

  it('treats a missing attempt as zero', () => {
    expect(countFixAttempts([{ stageKey: 'uat' }], 'uat')).toBe(0);
  });
});

describe('lastFailedGate', () => {
  it('names the gate stage that failed most recently', () => {
    expect(
      lastFailedGate([
        { stageKey: 'uat', status: 'failed', endedAt: '2026-07-30T09:00:00.000Z' },
        { stageKey: 'review', status: 'failed', endedAt: '2026-07-30T10:00:00.000Z' },
      ]),
    ).toBe('review');
  });

  it('ignores a gate that did not fail', () => {
    expect(
      lastFailedGate([
        { stageKey: 'uat', status: 'failed', endedAt: '2026-07-30T09:00:00.000Z' },
        { stageKey: 'review', status: 'passed', endedAt: '2026-07-30T10:00:00.000Z' },
      ]),
    ).toBe('uat');
  });

  it('returns null when no gate has failed', () => {
    expect(lastFailedGate([{ stageKey: 'uat', status: 'running', endedAt: null }])).toBeNull();
  });
});

describe('fixAttemptsRemain', () => {
  it('honours a caller-supplied cap for uat.maxFixAttempts', () => {
    expect(fixAttemptsRemain(1, 2)).toBe(true);
    expect(fixAttemptsRemain(2, 2)).toBe(false);
    expect(fixAttemptsRemain(FIX_ATTEMPT_CAP - 1)).toBe(true);
    expect(fixAttemptsRemain(FIX_ATTEMPT_CAP)).toBe(false);
  });
});

describe('capForGate', () => {
  it('honours a narrowed uat budget', () => {
    expect(capForGate('uat', 1)).toBe(1);
  });

  it('falls back to the default cap when uat declares no budget', () => {
    expect(capForGate('uat', undefined)).toBe(FIX_ATTEMPT_CAP);
  });

  it('ignores uatMax for review — a gate’s budget is its own manifest key', () => {
    // `uat.maxFixAttempts` can never narrow a gate it does not name.
    expect(capForGate('review', 1)).toBe(FIX_ATTEMPT_CAP);
  });

  it('honours a narrowed review budget, and never lets it narrow uat', () => {
    expect(capForGate('review', undefined, 2)).toBe(2);
    expect(capForGate('uat', undefined, 2)).toBe(FIX_ATTEMPT_CAP);
  });

  it('falls back to the default cap when review declares no budget', () => {
    expect(capForGate('review', undefined, undefined)).toBe(FIX_ATTEMPT_CAP);
  });
});
