import { describe, expect, it } from 'vitest';
import { buildShipSlot, type ShipSlot } from './shipSlot.js';
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

  it('keeps the states mutually exclusive — a blocked cell is never confirm/retry/shipping', () => {
    const slot = buildShipSlot(cell({ status: 'passed', blocked: { kind: 'awaiting-merge', reason: 'r', at: 't', resumable: false } }), undefined);
    expect(slot.kind).toBe('waiting-merge');
  });
});
