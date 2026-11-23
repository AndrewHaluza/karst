import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { createTicketFlow } from '../../workflow/stages/create.js';
import { openRecoveryRound } from '../../store/recoveryRounds.js';
import { parkRoundOutOfFixing } from '../../store/hostRerunRound.js';
import { setStage } from '../../store/stages.js';
import { setStageCurrent, getTicket } from '../../store/tickets.js';
import { upsertProject } from '../../store/projects.js';
import { makeFixParkActions } from './fixParkOps.js';
import type { Notify } from './notify.js';

const AT = '2026-01-01T00:00:00Z';

describe('makeFixParkActions', () => {
  let store: Store;
  let ticketId: number;
  let notify: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };
  let redrive: ReturnType<typeof vi.fn<(ticketId: number) => void>>;
  let refresh: ReturnType<typeof vi.fn<() => void>>;
  const actions = () => makeFixParkActions({ store, ticketId, notify: notify as unknown as Notify, redrive, refresh, now: () => AT });

  const park = (): void => {
    const id = openRecoveryRound(store, {
      ticketId, sourceStage: 'review', sourceProcessId: 'review', triggerKind: 'blocking-review-findings',
      triggerDetail: 'x', maxRounds: 3, startedAt: AT,
    } as never).id;
    store.db.prepare("UPDATE recovery_rounds SET status = 'fixing' WHERE id = ?").run(id);
    parkRoundOutOfFixing(store, id, 'parked', AT);
    setStage(store, ticketId, 'review', { status: 'failed', startedAt: AT });
    setStage(store, ticketId, 'fix', { status: 'failed', verdict: 'parked', endedAt: AT });
    setStageCurrent(store, ticketId, 'fix');
  };

  beforeEach(() => {
    store = openStore(':memory:');
    const projectId = upsertProject(store, { slug: 'p' }).id;
    ticketId = createTicketFlow(store, { key: 'T-1', title: 't', projectId }).id;
    notify = { info: vi.fn(), warn: vi.fn() };
    redrive = vi.fn();
    refresh = vi.fn();
  });

  it('accept: records, redrives and refreshes', async () => {
    park();
    await actions().fixParkedAccept('  ok  ');
    expect(getTicket(store, ticketId).stageCurrent).toBe('ship');
    expect(notify.info).toHaveBeenCalledOnce();
    expect(redrive).toHaveBeenCalledWith(ticketId);
    expect(refresh).toHaveBeenCalled();
  });

  it('retry: returns to the source stage, redrives and refreshes', async () => {
    park();
    await actions().fixParkedRetry();
    expect(getTicket(store, ticketId).stageCurrent).toBe('review');
    expect(redrive).toHaveBeenCalledWith(ticketId);
    expect(refresh).toHaveBeenCalled();
  });

  it('a refusal warns, does not redrive and refreshes', async () => {
    await actions().fixParkedAccept('');
    await actions().fixParkedRetry();
    expect(notify.warn).toHaveBeenCalledTimes(2);
    expect(redrive).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});
