import { describe, it, expect } from 'vitest';
import {
  countFixAttempts,
  lastFailedGate,
  fixAttemptsRemain,
  capForGate,
  roundFixDecision,
  FIX_ATTEMPT_CAP,
} from './fixAttempts.js';
import { buildStepper, type StepperStageRow } from '../model/stepper.js';
import { buildStageRail } from '../model/stageRail.js';

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

describe('roundFixDecision', () => {
  it('resumes a round below its committed cap, carrying the round id', () => {
    expect(roundFixDecision({ roundId: 7, round: 1, maxRounds: 3 })).toEqual({
      kind: 'resume',
      roundId: 7,
      attempts: 1,
    });
  });

  it('exhausts a round at its committed cap — the snapshot, not the live manifest', () => {
    expect(roundFixDecision({ roundId: 8, round: 2, maxRounds: 2 })).toEqual({
      kind: 'exhausted',
      roundId: 8,
      attempts: 2,
      cap: 2,
    });
  });

  it('never lets a round exceed the default cap either', () => {
    expect(roundFixDecision({ roundId: 9, round: FIX_ATTEMPT_CAP, maxRounds: FIX_ATTEMPT_CAP })).toEqual({
      kind: 'exhausted',
      roundId: 9,
      attempts: FIX_ATTEMPT_CAP,
      cap: FIX_ATTEMPT_CAP,
    });
  });
});

describe('ship as a fix-budget gate', () => {
  it('lastFailedGate names a failed ship row', () => {
    expect(
      lastFailedGate([
        { stageKey: 'ship', status: 'failed', endedAt: '2026-07-30T10:00:00.000Z' },
      ]),
    ).toBe('ship');
  });

  it('picks the later of a failed review and a failed ship by endedAt', () => {
    expect(
      lastFailedGate([
        { stageKey: 'review', status: 'failed', endedAt: '2026-07-30T09:00:00.000Z' },
        { stageKey: 'ship', status: 'failed', endedAt: '2026-07-30T10:00:00.000Z' },
      ]),
    ).toBe('ship');
    expect(
      lastFailedGate([
        { stageKey: 'ship', status: 'failed', endedAt: '2026-07-30T09:00:00.000Z' },
        { stageKey: 'review', status: 'failed', endedAt: '2026-07-30T10:00:00.000Z' },
      ]),
    ).toBe('review');
  });

  it('prices ship at the default cap, ignoring both manifest values', () => {
    expect(capForGate('ship', 9, 9)).toBe(FIX_ATTEMPT_CAP);
    // The existing per-gate arms are untouched.
    expect(capForGate('uat', 5, 9)).toBe(5);
    expect(capForGate('review', 5, 9)).toBe(9);
  });

  // The rail is not edited, but widening `GateStageKey` makes the meter reach
  // `ship` for free — and that is the intended outcome, so pin it. A later
  // `'ship'` exclusion from the rail fails here loudly.
  it('the stage rail draws a retry meter for a ship-sourced round', () => {
    const stages: StepperStageRow[] = [
      { stageKey: 'ship', status: 'failed', attempt: 1, endedAt: '2026-07-30T10:00:00.000Z' },
    ];
    const rail = buildStageRail(buildStepper(stages), stages, {
      current: 'fix',
      needsUser: false,
      needs: null,
    });
    const ship = rail.main.find((s) => s.cell.stageKey === 'ship')!;
    expect(ship.retry).toMatchObject({
      gate: 'ship',
      spent: 1,
      cap: FIX_ATTEMPT_CAP,
      returnsTo: 'uat',
    });
  });
});
