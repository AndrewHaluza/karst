import { describe, expect, it } from 'vitest';
import { deliverRowInput } from './stateActions.js';
import type { DeliverFacts } from '../../model/inside/deliver.js';

const auto: DeliverFacts = { running: null, failures: [], takenOver: null, roundActive: false, headSha: null };

describe('deliverRowInput', () => {
  it('is null with neither commits to push nor an auto-deliver record', () => {
    expect(deliverRowInput(undefined, undefined)).toBeNull();
  });

  it('sums the host and sandbox commits and keeps the sandbox count', () => {
    expect(deliverRowInput({ hostAhead: 1, sandboxAhead: 2 }, undefined)).toEqual({ canDeliver: true, notOnPr: 3, inSandbox: 2, auto: null });
  });

  it('keeps the record alone when nothing is left to push', () => {
    expect(deliverRowInput(undefined, auto)).toEqual({ canDeliver: false, notOnPr: 0, inSandbox: 0, auto });
  });
});
