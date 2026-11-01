import { describe, expect, it } from 'vitest';
import { classifyEnd, commandGateRecord, GATE_TABLE, overlayRaisesUserGate, USER_DECIDED_KINDS } from './evalPolicy.mjs';

const st = (stageKey, status, extra = {}) => ({ stageKey, status, ...extra });

describe('classifyEnd', () => {
  it('terminal when ship is pending and earlier stages passed', () => {
    const r = classifyEnd({ stageCurrent: 'ship', stages: [st('impl', 'passed'), st('uat', 'bypassed'), st('ship', 'pending')] });
    expect(r).toEqual({ outcome: 'terminal', stage: 'ship', blockedKind: null, reason: null });
  });
  it('not terminal when an earlier stage failed', () => {
    const r = classifyEnd({ stageCurrent: 'ship', stages: [st('impl', 'failed'), st('ship', 'pending')] });
    expect(r.outcome).not.toBe('terminal');
  });
  it('records blocked kind and reason', () => {
    const r = classifyEnd({ stageCurrent: 'uat', stages: [st('uat', 'running', { blockedKind: 'boot-failed', blockedReason: 'no port' })] });
    expect(r).toEqual({ outcome: 'blocked', stage: 'uat', blockedKind: 'boot-failed', reason: 'no port' });
  });
  it('timeout, failed and incomplete stay distinct', () => {
    expect(classifyEnd({ stageCurrent: 'impl', stages: [st('impl', 'running')], timedOut: true }).outcome).toBe('timeout');
    expect(classifyEnd({ stageCurrent: 'impl', stages: [st('impl', 'failed')] }).outcome).toBe('failed');
    expect(classifyEnd({ stageCurrent: 'impl', stages: [st('impl', 'running')] }).outcome).toBe('incomplete');
  });
  it('a user-decided block is blocked, never a silent timeout', () => {
    for (const kind of USER_DECIDED_KINDS) {
      const r = classifyEnd({ stageCurrent: 'uat', stages: [st('uat', 'running', { blockedKind: kind })], timedOut: true });
      expect(r.outcome).toBe('blocked');
    }
  });
});

describe('overlay and command gates', () => {
  it('flags manifests that would raise a user-decided gate', () => {
    expect(overlayRaisesUserGate('uat:\n  baselineReview:\n    paths: [a]\n')).toBe(true);
    expect(overlayRaisesUserGate('approaches:\n  x: {}\n')).toBe(true);
    expect(overlayRaisesUserGate('repositories:\n  r: {}\n')).toBe(false);
  });
  it('records no-command as skipped', () => {
    expect(commandGateRecord([])).toEqual([{ gate: 'uat', status: 'skipped', reason: 'no-command' }]);
    expect(commandGateRecord([{ name: 't' }])).toEqual([{ gate: 't', status: 'declared' }]);
  });
  it('gate table covers both user-decided kinds', () => {
    for (const k of USER_DECIDED_KINDS) expect(GATE_TABLE.some((g) => g.gate === k)).toBe(true);
  });
});
