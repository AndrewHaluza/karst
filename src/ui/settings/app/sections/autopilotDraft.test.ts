import { describe, expect, it } from 'vitest';
import type { Manifest } from '../../../../manifest/types.js';
import {
  addCheck,
  autopilotView,
  removeCheck,
  setCiMaxAttempts,
  setCiPolicy,
  setConflictsMaxRounds,
  setConflictsPolicy,
  setEnabled,
} from './autopilotDraft.js';

const BASE = { id: 'p' } as unknown as Manifest;

describe('autopilotView', () => {
  it('shows the engine defaults for an absent block', () => {
    expect(autopilotView(BASE)).toEqual({
      enabled: false,
      ci: { policy: 'auto', maxAttempts: 3, checks: [] },
      conflicts: { policy: 'auto', maxRounds: 2 },
    });
  });
});

describe('autopilot draft updaters', () => {
  it('writes a full block on the first edit', () => {
    const next = setEnabled(true)(BASE);
    expect(next.autopilot).toEqual({
      enabled: true,
      ci: { policy: 'auto', maxAttempts: 3, checks: [] },
      conflicts: { policy: 'auto', maxRounds: 2 },
    });
  });

  it('never mutates the draft it receives', () => {
    const draft = { ...BASE, autopilot: autopilotView(BASE) } as Manifest;
    const frozen = JSON.stringify(draft);
    setCiPolicy('ask')(draft);
    addCheck('lint')(draft);
    expect(JSON.stringify(draft)).toBe(frozen);
  });

  it('sets each policy independently', () => {
    const a = setCiPolicy('ask')(BASE);
    const b = setConflictsPolicy('ask')(a);
    expect(b.autopilot?.ci.policy).toBe('ask');
    expect(b.autopilot?.conflicts.policy).toBe('ask');
  });

  it('keeps a valid whole number and holds the last good value for a bad one', () => {
    const ok = setConflictsMaxRounds('4')(BASE);
    expect(ok.autopilot?.conflicts.maxRounds).toBe(4);
    const attempts = setCiMaxAttempts('5')(ok);
    expect(attempts.autopilot?.ci.maxAttempts).toBe(5);
  });

  it('stores an out-of-range number so the host can name the fault', () => {
    expect(setConflictsMaxRounds('0')(BASE).autopilot?.conflicts.maxRounds).toBe(0);
    expect(setCiMaxAttempts('-2')(BASE).autopilot?.ci.maxAttempts).toBe(-2);
  });

  it('ignores text that is not a number', () => {
    const start = setCiMaxAttempts('5')(BASE);
    expect(setCiMaxAttempts('abc')(start).autopilot?.ci.maxAttempts).toBe(5);
  });

  it('adds a trimmed check once and removes it by name', () => {
    const one = addCheck('  lint ')(BASE);
    expect(one.autopilot?.ci.checks).toEqual(['lint']);
    expect(addCheck('lint')(one).autopilot?.ci.checks).toEqual(['lint']);
    expect(addCheck('   ')(one).autopilot?.ci.checks).toEqual(['lint']);
    const two = addCheck('typecheck')(one);
    expect(removeCheck('lint')(two).autopilot?.ci.checks).toEqual(['typecheck']);
  });
});
