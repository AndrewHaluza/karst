import { describe, it, expect, vi, beforeEach } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { createTicket, pauseTicket, getTicket } from '../store/tickets.js';

const { showWarningMessage } = vi.hoisted(() => ({ showWarningMessage: vi.fn() }));
vi.mock('vscode', () => ({ window: { showWarningMessage } }));

import { askPausedModal } from './pausedModal.js';

describe('askPausedModal', () => {
  let store: Store;
  let id: number;
  beforeEach(() => {
    showWarningMessage.mockReset();
    store = openStore(':memory:');
    id = createTicket(store, { key: 'T-1', title: 't' }).id;
  });

  it('proceeds without a prompt when the ticket runs', async () => {
    const after = vi.fn();
    expect(await askPausedModal(store, id, 'retry UAT', 'Retry UAT', after)).toBe('proceed');
    expect(showWarningMessage).not.toHaveBeenCalled();
    expect(after).not.toHaveBeenCalled();
  });

  it('asks a modal and unpauses on the first choice', async () => {
    pauseTicket(store, id);
    showWarningMessage.mockResolvedValue('Unpause and Retry UAT');
    const after = vi.fn();
    expect(await askPausedModal(store, id, 'retry UAT', 'Retry UAT', after)).toBe('proceed');
    expect(showWarningMessage).toHaveBeenCalledWith(
      'T-1 is paused, so retry UAT will not run until you unpause.',
      { modal: true },
      'Unpause and Retry UAT',
      'Retry UAT only, keep paused',
    );
    expect(getTicket(store, id).pausedAt).toBeNull();
    expect(after).toHaveBeenCalledTimes(1);
  });

  it('keeps the ticket paused on the second choice', async () => {
    pauseTicket(store, id);
    showWarningMessage.mockResolvedValue('Retry UAT only, keep paused');
    const after = vi.fn();
    expect(await askPausedModal(store, id, 'retry UAT', 'Retry UAT', after)).toBe('proceed');
    expect(getTicket(store, id).pausedAt).not.toBeNull();
    expect(after).not.toHaveBeenCalled();
  });

  it('cancels on dismiss', async () => {
    pauseTicket(store, id);
    showWarningMessage.mockResolvedValue(undefined);
    expect(await askPausedModal(store, id, 'x', 'X', vi.fn())).toBe('cancel');
  });
});
