import { describe, it, expect, vi, beforeEach } from 'vitest';

const { showWarningMessage } = vi.hoisted(() => ({ showWarningMessage: vi.fn() }));
vi.mock('vscode', () => ({ window: { showWarningMessage } }));

import { offerPlannerRestart } from './planningRestartOffer.js';

describe('offerPlannerRestart', () => {
  beforeEach(() => showWarningMessage.mockReset());
  const labels = { restart: 'Restart', keep: 'Keep' };

  it('offers both labels and maps the restart pick', async () => {
    showWarningMessage.mockResolvedValue('Restart');
    expect(await offerPlannerRestart('msg', labels)).toBe('restart');
    expect(showWarningMessage).toHaveBeenCalledWith('msg', 'Restart', 'Keep');
  });
  it('maps the keep pick', async () => {
    showWarningMessage.mockResolvedValue('Keep');
    expect(await offerPlannerRestart('msg', labels)).toBe('keep');
  });
  it('returns undefined on dismiss', async () => {
    showWarningMessage.mockResolvedValue(undefined);
    expect(await offerPlannerRestart('msg', labels)).toBeUndefined();
  });
});
