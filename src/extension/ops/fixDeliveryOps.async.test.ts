import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { currentFixDelivery, getFixDelivery, upsertFixDelivery } from '../../store/fixDeliveries.js';
import { deliverLiveFix, isThenable, sendTypedPointer, type FixDeliveryHost, type TypedSendResult } from './fixDeliveryOps.js';
import { makeHarness, type Harness } from '../../store/fixtures/fixDeliveryHarness.js';

/**
 * The async-capable delivery chain (D556): a sandboxed ssh row mirrors its
 * brief before any pointer is sent, so `writeBrief` and `sendPointer` may
 * return a promise. Each branch must give the same result as the sync path.
 */
describe('fixDeliveryOps (async mirror path, D556)', () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => h.store.close());

  const input = () => ({ ticketId: h.ticketId, roundId: null, body: 'BRIEF', truncatedFooter: 'FOOT' });
  const withHost = (over: Partial<FixDeliveryHost>): FixDeliveryHost => ({ ...h.host, ...over });

  it('isThenable: true only for an object with a then function', () => {
    expect(isThenable(Promise.resolve(1))).toBe(true);
    expect(isThenable(1)).toBe(false);
    expect(isThenable(null as unknown as number)).toBe(false);
    expect(isThenable({ then: 1 } as unknown as number)).toBe(false);
  });

  it('a sync mirror-refused write fails the delivery and sends no pointer', () => {
    h.state.idle = true;
    expect(deliverLiveFix(withHost({ writeBrief: () => 'mirror-refused' }), input())).toBe(false);
    expect(h.sent).toEqual([]);
  });

  it('an async mirror-refused write resolves false and sends no pointer', async () => {
    h.state.idle = true;
    await expect(deliverLiveFix(withHost({ writeBrief: async () => 'mirror-refused' as const }), input())).resolves.toBe(false);
    expect(h.sent).toEqual([]);
  });

  it('an async refused host write resolves true (the sweep retries) and sends no pointer', async () => {
    h.state.idle = true;
    await expect(deliverLiveFix(withHost({ writeBrief: async () => false }), input())).resolves.toBe(true);
    expect(h.sent).toEqual([]);
    expect(currentFixDelivery(h.store, h.ticketId)!.armedAt).toBeNull();
  });

  it('an async written brief arms and types the idle push pointer, with briefWritten', async () => {
    h.state.idle = true;
    const opts: unknown[] = [];
    const host = withHost({
      writeBrief: async () => true,
      sendPointer: (id, deliveryId, hooks, o) => {
        opts.push(o);
        return h.host.sendPointer(id, deliveryId, hooks);
      },
    });
    await expect(deliverLiveFix(host, input())).resolves.toBe(true);
    const row = currentFixDelivery(h.store, h.ticketId)!;
    expect(opts).toEqual([{ briefWritten: true }]);
    expect(vi.mocked(h.host.debug)).toHaveBeenCalledWith(`[driver] fix delivery #${row.id}: stored for ticket ${h.ticketId}, route hook-block`);
  });

  it('a typed-route async pointer that is unavailable supersedes the row and resolves false', async () => {
    h.state.route = 'typed';
    const host = withHost({ sendPointer: async () => 'unavailable' as TypedSendResult });
    await expect(deliverLiveFix(host, input())).resolves.toBe(false);
    expect(currentFixDelivery(h.store, h.ticketId)).toBeNull();
  });

  it('a queued first send keeps the enqueued claim (sync and async)', async () => {
    const id = upsertFixDelivery(h.store, { ticketId: h.ticketId, recoveryRoundId: null, launchId: 'L1', body: 'b', at: 'a' });
    expect(sendTypedPointer(h.host, getFixDelivery(h.store, id)!, 'first')).toBe('queued');
    expect(getFixDelivery(h.store, id)!.enqueuedAt).not.toBeNull();
    const id2 = upsertFixDelivery(h.store, { ticketId: h.ticketId, recoveryRoundId: null, launchId: 'L2', body: 'b2', at: 'a' });
    const host = withHost({ sendPointer: async () => 'queued' as TypedSendResult });
    await expect(sendTypedPointer(host, getFixDelivery(h.store, id2)!, 'first')).resolves.toBe('queued');
    expect(getFixDelivery(h.store, id2)!.enqueuedAt).not.toBeNull();
  });

  it('an async held first send frees the enqueued claim', async () => {
    const id = upsertFixDelivery(h.store, { ticketId: h.ticketId, recoveryRoundId: null, launchId: 'L1', body: 'b', at: 'a' });
    const host = withHost({ sendPointer: async () => 'held' as TypedSendResult });
    await expect(sendTypedPointer(host, getFixDelivery(h.store, id)!, 'first')).resolves.toBe('held');
    expect(getFixDelivery(h.store, id)!.enqueuedAt).toBeNull();
  });

  it('a held re-send keeps the enqueued claim of the first send', () => {
    const id = upsertFixDelivery(h.store, { ticketId: h.ticketId, recoveryRoundId: null, launchId: 'L1', body: 'b', at: 'a' });
    expect(sendTypedPointer(h.host, getFixDelivery(h.store, id)!, 'first')).toBe('queued');
    const host = withHost({ sendPointer: () => 'held' as TypedSendResult });
    expect(sendTypedPointer(host, getFixDelivery(h.store, id)!, 'resend')).toBe('held');
    expect(getFixDelivery(h.store, id)!.enqueuedAt).not.toBeNull();
  });
});
