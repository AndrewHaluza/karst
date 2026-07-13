import { describe, it, expect } from 'vitest';
import { buildStepper } from './stepper.js';

describe('buildStepper', () => {
  it('orders cells by STAGE_KEYS regardless of input order', () => {
    const cells = buildStepper([
      { stageKey: 'impl', status: 'running' },
      { stageKey: 'scope', status: 'passed' },
    ]);
    expect(cells.map((c) => c.stageKey)).toEqual([
      'scope', 'impl', 'uat', 'review', 'fix', 'ship', 'done',
    ]);
    expect(cells[0]).toEqual({ stageKey: 'scope', status: 'passed' });
    expect(cells[1]).toEqual({ stageKey: 'impl', status: 'running' });
  });

  it('defaults a stage with no row to pending', () => {
    const cells = buildStepper([{ stageKey: 'scope', status: 'passed' }]);
    expect(cells.find((c) => c.stageKey === 'uat')!.status).toBe('pending');
  });

  it('returns all pending for an empty ticket', () => {
    const cells = buildStepper([]);
    expect(cells).toHaveLength(7);
    expect(cells.every((c) => c.status === 'pending')).toBe(true);
  });
});
