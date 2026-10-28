import { describe, it, expect, vi } from 'vitest';
import { openStore } from '../../store/db.js';
import { createTicketFlow } from '../../workflow/stages/create.js';
import { transition } from '../../workflow/machine.js';
import { setStage } from '../../store/stages.js';
import { getTicket } from '../../store/tickets.js';
import { resetStageAction } from './resetStageAction.js';

const flush = () => new Promise((r) => setTimeout(r, 0));

function setup(confirm: boolean) {
  const store = openStore(':memory:');
  const ticketId = createTicketFlow(store, { key: 'T-1', title: 't' }).id;
  transition(store, ticketId, 'scope', { kind: 'passed' });
  transition(store, ticketId, 'impl', { kind: 'passed' });
  setStage(store, ticketId, 'uat', { status: 'failed' });
  const deps = {
    store, ticketId, afterServerChange: vi.fn(), logError: vi.fn(), debug: vi.fn(), drive: vi.fn(),
    info: vi.fn(), error: vi.fn(), confirm: vi.fn(async () => confirm),
  };
  return { store, ticketId, deps };
}

describe('resetStageAction', () => {
  it('confirmed: resets, moves to the gate, re-drives and refreshes', async () => {
    const { store, ticketId, deps } = setup(true);
    resetStageAction(deps);
    await flush();
    expect(getTicket(store, ticketId).stageCurrent).toBe('uat');
    expect(deps.drive).toHaveBeenCalledOnce();
    expect(deps.afterServerChange).toHaveBeenCalledOnce();
  });

  it('dismissed: nothing runs but the dashboard still refreshes', async () => {
    const { deps } = setup(false);
    resetStageAction(deps);
    await flush();
    expect(deps.drive).not.toHaveBeenCalled();
    expect(deps.afterServerChange).toHaveBeenCalledOnce();
  });

  it('unavailable: tells the user, no drive', async () => {
    const { store, ticketId, deps } = setup(true);
    setStage(store, ticketId, 'uat', { status: 'pending' });
    resetStageAction(deps);
    await flush();
    expect(deps.info).toHaveBeenCalledOnce();
    expect(deps.drive).not.toHaveBeenCalled();
  });
});
