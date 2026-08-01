import { describe, it, expect } from 'vitest';
import { MAIN_LINE } from '../workflow/graph.js';
import { buildStepper, type StepperStageRow } from './stepper.js';
import { buildStageRail } from './stageRail.js';
import type { StageKey, StageStatus } from './types.js';

function rail(stages: Partial<Record<StageKey, StageStatus>>, fixAttempts = 0) {
  const rows: StepperStageRow[] = Object.entries(stages).map(([stageKey, status]) => ({
    stageKey: stageKey as StageKey,
    status: status as StageStatus,
  }));
  return buildStageRail(buildStepper(rows), fixAttempts);
}

describe('buildStageRail', () => {
  it('never puts fix on the main line', () => {
    // The bug this whole rail exists to fix: `fix` is entered only when a gate
    // fails and returns to review on pass, so drawing it as a step between
    // review and ship claims a forward path that does not exist.
    const r = rail({});
    expect(r.main.map((c) => c.stageKey)).not.toContain('fix');
  });

  it('lays the main line out in MAIN_LINE order', () => {
    expect(rail({}).main.map((c) => c.stageKey)).toEqual([...MAIN_LINE]);
  });

  it('carries fix as the branch, with its own cell state', () => {
    const r = rail({ fix: 'running' });
    expect(r.branch.stageKey).toBe('fix');
    expect(r.branch.status).toBe('running');
  });

  it('carries a successful fix as passed so the branch can render healthy', () => {
    expect(rail({ fix: 'passed' }).branch).toMatchObject({
      stageKey: 'fix',
      status: 'passed',
    });
  });

  it('gives every stage a place — main and branch together cover the stepper', () => {
    const r = rail({});
    const placed = [...r.main.map((c) => c.stageKey), r.branch.stageKey];
    expect(new Set(placed).size).toBe(8);
  });

  it('derives the column geometry from MAIN_LINE rather than hardcoding it', () => {
    const r = rail({});
    expect(r.geometry).toEqual({
      cols: MAIN_LINE.length,
      impl: MAIN_LINE.indexOf('impl'),
      uat: MAIN_LINE.indexOf('uat'),
      review: MAIN_LINE.indexOf('review'),
    });
  });

  it('arms the loop while fix is running', () => {
    expect(rail({ fix: 'running' }).armed).toBe(true);
  });

  it('arms the loop while a gate sits failed', () => {
    expect(rail({ review: 'failed' }).armed).toBe(true);
    expect(rail({ uat: 'failed' }).armed).toBe(true);
  });

  it('leaves the loop idle when no gate has failed and fix is not running', () => {
    expect(rail({ scope: 'passed', impl: 'running' }).armed).toBe(false);
  });

  it('does not arm on a non-gate failure — ship failing is not the fix loop', () => {
    // ship has no failed edge; a failed ship is a dead end the user retries, not
    // a trip round the fix loop.
    expect(rail({ ship: 'failed' }).armed).toBe(false);
  });

  it('names the attempt once the loop has been entered', () => {
    expect(rail({ fix: 'running' }, 2).cap).toBe('attempt 2 of 3');
  });

  it('has no cap to state before the loop is entered', () => {
    expect(rail({}, 0).cap).toBeNull();
  });
});
