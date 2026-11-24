import { describe, expect, it } from 'vitest';
import { buildShipSlot, mergeBlockedDetail, type ShipSlot } from './shipSlot.js';
import type { StepperCell } from './stepper.js';

function cell(overrides: Partial<StepperCell> = {}): StepperCell {
  return { stageKey: 'ship', status: 'pending', ...overrides } as StepperCell;
}

describe('buildShipSlot', () => {
  it('is none when the ticket is not at ship or has no cell', () => {
    expect(buildShipSlot(null, undefined)).toEqual({ kind: 'none' });
    expect(buildShipSlot(cell({ stageKey: 'impl' }), undefined)).toEqual({ kind: 'none' });
  });

  it('offers confirm when ship is ready and not blocked', () => {
    expect(buildShipSlot(cell({ status: 'passed' }), undefined)).toEqual({ kind: 'confirm' });
    expect(buildShipSlot(cell({ status: 'pending' }), undefined)).toEqual({ kind: 'confirm' });
  });

  it('reports shipping while the ship run is in flight', () => {
    expect(buildShipSlot(cell({ status: 'running' }), undefined)).toEqual({ kind: 'shipping' });
  });

  it('offers retry (with the reason) when ship failed', () => {
    expect(buildShipSlot(cell({ status: 'failed', reason: 'gh pr create failed' }), undefined)).toEqual({
      kind: 'retry', reason: 'gh pr create failed',
    });
    expect(buildShipSlot(cell({ status: 'failed' }), undefined)).toEqual({ kind: 'retry', reason: null });
  });

  it('reports waiting-merge with the pending repo count when the ship cell is parked awaiting merge', () => {
    expect(buildShipSlot(
      cell({ status: 'passed', blocked: { kind: 'awaiting-merge', reason: 'PR open', at: 'x', resumable: false } }),
      { repos: ['api', 'web'] },
    )).toEqual({ kind: 'waiting-merge', repos: 2 });
    expect(buildShipSlot(
      cell({ status: 'passed', blocked: { kind: 'awaiting-merge', reason: 'PR open', at: 'x', resumable: false } }),
      undefined,
    )).toEqual({ kind: 'waiting-merge', repos: 0 });
  });

  it('reports merge-blocked with the conflicted repos only while a conflict parks the ticket on the user (DB-3)', () => {
    const parked = cell({ status: 'passed', blocked: { kind: 'awaiting-merge', reason: 'PR open', at: 'x', resumable: false } });
    const gate = { kind: 'conflicted', repos: ['web', 'api'], pending: [] } as const;
    expect(buildShipSlot(parked, gate, true)).toEqual({ kind: 'merge-blocked', repos: ['web', 'api'] });
    // A conflicted read with no repo names nothing to resolve: it stays the calm wait.
    expect(buildShipSlot(parked, { kind: 'conflicted', repos: [] }, true)).toEqual({ kind: 'waiting-merge', repos: 0 });
    // CI running or a deliver run yields the needs-you reading: the chip stays a calm wait (@arch:BLOCKED).
    expect(buildShipSlot(parked, gate, false)).toEqual({ kind: 'waiting-merge', repos: 2 });
    expect(buildShipSlot(parked, gate)).toEqual({ kind: 'waiting-merge', repos: 2 });
    expect(buildShipSlot(parked, { kind: 'awaiting', repos: ['web'] }, true)).toEqual({ kind: 'waiting-merge', repos: 1 });
    // A re-push runs over the stored block: it ships, whatever the gate says.
    expect(buildShipSlot(cell({ status: 'running', blocked: parked.blocked }), gate, true)).toEqual({ kind: 'shipping' });
  });

  it('reports shipping for a re-push that runs over a stored awaiting-merge block', () => {
    expect(buildShipSlot(
      cell({ status: 'running', blocked: { kind: 'awaiting-merge', reason: 'PR open', at: 'x', resumable: false } }),
      { repos: ['web'] },
    )).toEqual({ kind: 'shipping' });
  });

  it('keeps the states mutually exclusive — a blocked cell is never confirm/retry/shipping', () => {
    const slot = buildShipSlot(cell({ status: 'passed', blocked: { kind: 'awaiting-merge', reason: 'r', at: 't', resumable: false } }), undefined);
    expect(slot.kind).toBe('waiting-merge');
  });
});

describe('mergeBlockedDetail', () => {
  it('words one repo and several', () => {
    expect(mergeBlockedDetail(1)).toBe('1 repo no longer merges cleanly');
    expect(mergeBlockedDetail(2)).toBe('2 repos no longer merge cleanly');
  });
});
