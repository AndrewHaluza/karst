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
import { recordFindings } from '../../store/reviewFindings.js';
import { listFixRoundAcceptances } from '../../store/fixRoundAcceptances.js';

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

  it('accept: the injected severity floor decides which findings the decision records', async () => {
    park();
    recordFindings(store, { ticketId, attempt: 1, runAt: AT, findings: [
      { severity: 'high', repo: '', title: 'egress', detail: 'd', source: 'agent' },
    ] });
    const withFloor = makeFixParkActions({ store, ticketId, notify: notify as unknown as Notify, redrive, refresh, now: () => AT, blockingSeverityOf: () => 'none' });
    await withFloor.fixParkedAccept('');
    expect(listFixRoundAcceptances(store, ticketId)[0]?.items).toEqual([]);
  });

  it('accept: without an injected floor the default floor records a high finding', async () => {
    park();
    recordFindings(store, { ticketId, attempt: 1, runAt: AT, findings: [
      { severity: 'high', repo: '', title: 'egress', detail: 'd', source: 'agent' },
    ] });
    await actions().fixParkedAccept('');
    expect(listFixRoundAcceptances(store, ticketId)[0]?.items).toEqual(['[high] egress']);
  });

  it('accept: stores the trimmed note', async () => {
    park();
    await actions().fixParkedAccept('  ok  ');
    expect(listFixRoundAcceptances(store, ticketId)[0]?.note).toBe('ok');
  });

  it('retry: notifies the stage that runs again', async () => {
    park();
    await actions().fixParkedRetry();
    expect(notify.info.mock.calls[0]?.[0]).toMatch(/: the review gate runs again\.$/u);
  });

  it('notifies with the stage the user moved past, and with the reason on a refusal', async () => {
    park();
    await actions().fixParkedAccept('');
    expect(notify.info.mock.calls[0]?.[0]).toMatch(/: accepted and moved past the review gate\.$/u);
    await actions().fixParkedRetry();
    expect(notify.warn.mock.calls[0]?.[0]).toMatch(/: .+\.$/u);
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
