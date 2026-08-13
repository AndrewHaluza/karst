import { describe, it, expect } from 'vitest';
import { MAIN_LINE, STAGE_GRAPH } from '../workflow/graph.js';
import { FIX_ATTEMPT_CAP } from '../workflow/fixAttempts.js';
import { buildStepper, type StepperStageRow } from './stepper.js';
import { buildStageRail, type BuildRailOptions } from './stageRail.js';
import type { BlockerKind, StageKey, StageStatus } from './types.js';

type Row = {
  stageKey: StageKey;
  status: StageStatus;
  attempt?: number;
  endedAt?: string;
  blockedKind?: BlockerKind | null;
  blockedReason?: string | null;
  blockedAt?: string | null;
};

function rail(rows: Row[], opts: Partial<BuildRailOptions> = {}) {
  const stages: StepperStageRow[] = rows.map((r) => ({ ...r }));
  return buildStageRail(buildStepper(stages), stages, {
    current: null,
    needsUser: false,
    needs: null,
    ...opts,
  });
}

const seg = (r: ReturnType<typeof rail>, k: StageKey) => r.main.find((s) => s.cell.stageKey === k)!;

const AT = '2026-08-02T10:00:00.000Z';

describe('buildStageRail', () => {
  it('lays the main line out in MAIN_LINE order and never contains fix', () => {
    // The bug the track exists to fix: `fix` is reached only by a failed verdict
    // and its only edge returns to uat, so a forward slot for it claims a path
    // the graph does not have.
    const r = rail([]);
    expect(r.main.map((s) => s.cell.stageKey)).toEqual([...MAIN_LINE]);
    expect(r.main.map((s) => s.cell.stageKey)).not.toContain('fix');
  });

  it('carries no retry meter before any gate has failed', () => {
    // A meter on an untravelled ticket would reserve layout — and attention —
    // for a loop most tickets never enter.
    const r = rail([{ stageKey: 'impl', status: 'running' }]);
    expect(r.main.every((s) => s.retry === null)).toBe(true);
  });

  it('attaches the meter to the gate that failed, not to fix', () => {
    const r = rail([{ stageKey: 'uat', status: 'failed', attempt: 2, endedAt: AT }]);
    expect(seg(r, 'uat').retry).toMatchObject({ gate: 'uat', spent: 2, cap: FIX_ATTEMPT_CAP });
    expect(seg(r, 'review').retry).toBeNull();
  });

  it('counts attempts per gate, never summed across uat and review', () => {
    // The bug countFixAttempts was written to fix: two review failures must not
    // spend UAT's budget.
    const r = rail([
      { stageKey: 'uat', status: 'passed', attempt: 1, endedAt: '2026-08-02T09:00:00.000Z' },
      { stageKey: 'review', status: 'failed', attempt: 2, endedAt: AT },
    ]);
    expect(seg(r, 'review').retry?.spent).toBe(2);
  });

  it('reads the cap from the injected resolver, so a narrowed uat budget shows fewer ticks', () => {
    const r = rail([{ stageKey: 'uat', status: 'failed', attempt: 1, endedAt: AT }], {
      capFor: (gate) => (gate === 'uat' ? 1 : FIX_ATTEMPT_CAP),
    });
    expect(seg(r, 'uat').retry?.cap).toBe(1);
  });

  it('defaults the cap to the graph’s own, never to a guess', () => {
    const r = rail([{ stageKey: 'uat', status: 'failed', attempt: 1, endedAt: AT }]);
    expect(seg(r, 'uat').retry?.cap).toBe(FIX_ATTEMPT_CAP);
  });

  it('marks the meter live only while fix is actually running', () => {
    const running = rail([
      { stageKey: 'uat', status: 'failed', attempt: 1, endedAt: AT },
      { stageKey: 'fix', status: 'running' },
    ]);
    expect(seg(running, 'uat').retry?.live).toBe(true);

    const idle = rail([
      { stageKey: 'uat', status: 'failed', attempt: 1, endedAt: AT },
      { stageKey: 'fix', status: 'passed' },
    ]);
    expect(seg(idle, 'uat').retry?.live).toBe(false);
  });

  it('keeps the meter after the gate passes — a spent meter is a record, not an alarm', () => {
    // `lastFailedGate` needs a row still reading `failed`, and a gate that failed
    // and then passed has neither. Its `attempt` is what the ticket COST, and
    // that stays true once the gate is green.
    const r = rail([
      { stageKey: 'uat', status: 'passed', attempt: 2, endedAt: AT },
      { stageKey: 'fix', status: 'passed' },
      { stageKey: 'ship', status: 'pending' },
    ]);
    expect(seg(r, 'uat').retry).toMatchObject({ spent: 2, live: false });
  });

  it('reads returnsTo from the graph, and says nothing when the loop lands where it left', () => {
    // The shipped rail hardcoded `pass → review`; the graph says uat.
    const review = rail([{ stageKey: 'review', status: 'failed', attempt: 1, endedAt: AT }]);
    expect(seg(review, 'review').retry?.returnsTo).toBe(STAGE_GRAPH.fix.passed);
    expect(seg(review, 'review').retry?.returnsTo).toBe('uat');

    const uat = rail([{ stageKey: 'uat', status: 'failed', attempt: 1, endedAt: AT }]);
    expect(seg(uat, 'uat').retry?.returnsTo).toBeNull();
  });

  it('marks exactly one segment current', () => {
    const r = rail([{ stageKey: 'impl', status: 'running' }], { current: 'impl' });
    expect(r.main.filter((s) => s.current).map((s) => s.cell.stageKey)).toEqual(['impl']);
  });

  it('marks no segment current when the ticket sits at a stage off the main line', () => {
    // A ticket AT `fix` has no forward segment to highlight, and highlighting the
    // gate it came from would claim the ticket is there.
    const r = rail([{ stageKey: 'fix', status: 'running' }], { current: 'fix' });
    expect(r.main.some((s) => s.current)).toBe(false);
  });

  it('lands needs-you on the current segment and nowhere else', () => {
    const r = rail([{ stageKey: 'ship', status: 'pending' }], {
      current: 'ship',
      needsUser: true,
      needs: { detail: 'ready to open the PRs', action: 'Confirm ship', cta: { kind: 'ship-confirm' } },
    });
    expect(seg(r, 'ship').needsUser).toBe(true);
    expect(seg(r, 'ship').needs).toEqual({
      detail: 'ready to open the PRs',
      action: 'Confirm ship',
      cta: { kind: 'ship-confirm' },
    });
    expect(r.main.filter((s) => s.needsUser)).toHaveLength(1);
    expect(seg(r, 'done').needs).toBeNull();
  });

  it('never marks needs-you without a current segment to carry it', () => {
    const r = rail([], {
      current: null,
      needsUser: true,
      needs: { detail: 'x', action: 'y', cta: { kind: 'open-session' } },
    });
    expect(r.main.some((s) => s.needsUser)).toBe(false);
  });

  it('reads a parked running stage as blocked on its segment', () => {
    // `parkGateStage` leaves the runner's `running` status in place, so the
    // segment resolves the cell through displayStatus — the track must not
    // draw a spinner beside the block banner.
    const r = rail([
      {
        stageKey: 'uat',
        status: 'running',
        blockedKind: 'nothing-to-run',
        blockedReason: 'no target resolved',
        blockedAt: AT,
      },
    ]);
    expect(seg(r, 'uat').status).toBe('blocked');
    expect(seg(r, 'uat').cell.status).toBe('running');
  });

  it('keeps a passed stage with an awaiting-merge block passed', () => {
    // Ship waiting to land is genuinely passed — the block is a wait, not a
    // claim that the stage is still doing something.
    const r = rail([
      {
        stageKey: 'ship',
        status: 'passed',
        blockedKind: 'awaiting-merge',
        blockedReason: 'PRs open',
        blockedAt: AT,
      },
    ]);
    expect(seg(r, 'ship').status).toBe('passed');
  });

  it('resolves every segment, blocked or not', () => {
    const r = rail([
      { stageKey: 'scope', status: 'passed' },
      { stageKey: 'impl', status: 'running' },
      { stageKey: 'uat', status: 'running', blockedKind: 'nothing-to-run', blockedAt: AT },
    ]);
    expect(r.main.map((s) => [s.cell.stageKey, s.status])).toEqual([
      ['scope', 'passed'],
      ['impl', 'running'],
      ['uat', 'blocked'],
      ['review', 'pending'],
      ['ship', 'pending'],
      ['done', 'pending'],
    ]);
  });
});
