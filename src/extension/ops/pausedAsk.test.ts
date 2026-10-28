import { describe, it, expect, vi } from 'vitest';
import { askWhenPaused } from './pausedAsk.js';

function setup(paused: boolean, pick: string | undefined) {
  const calls: string[] = [];
  const choose = vi.fn(async (_m: string, _choices: string[]) => pick);
  const input = {
    key: 'T826',
    action: 'retry UAT',
    label: 'Retry UAT',
    isPaused: () => paused,
    unpause: () => void calls.push('unpause'),
    choose,
  };
  return { calls, choose, input };
}

describe('askWhenPaused', () => {
  it('not paused: proceeds without asking', async () => {
    const { input, choose } = setup(false, undefined);
    expect(await askWhenPaused(input)).toBe('proceed');
    expect(choose).not.toHaveBeenCalled();
  });
  it('paused: asks with the key, the action and the three buttons', async () => {
    const { input, choose } = setup(true, undefined);
    await askWhenPaused(input);
    expect(choose).toHaveBeenCalledWith('T826 is paused, so retry UAT will not run until you unpause.', [
      'Unpause and Retry UAT',
      'Retry UAT only, keep paused',
    ]);
  });
  it('Unpause and <action>: unpauses, then proceeds', async () => {
    const { input, calls } = setup(true, 'Unpause and Retry UAT');
    expect(await askWhenPaused(input)).toBe('proceed');
    expect(calls).toEqual(['unpause']);
  });
  it('<action> only: proceeds without unpausing', async () => {
    const { input, calls } = setup(true, 'Retry UAT only, keep paused');
    expect(await askWhenPaused(input)).toBe('proceed');
    expect(calls).toEqual([]);
  });
  it('Cancel / dismissed: does neither', async () => {
    const { input, calls } = setup(true, undefined);
    expect(await askWhenPaused(input)).toBe('cancel');
    expect(calls).toEqual([]);
  });
});
