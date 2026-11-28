import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { currentFixDelivery, getFixDelivery, upsertFixDelivery } from '../../store/fixDeliveries.js';
import { createTicket, setStageCurrent } from '../../store/tickets.js';
import { setMergeCheck } from '../../store/mergeChecks.js';
import { deliverLiveFix } from './fixDeliveryOps.js';
import { FIX_POINTER_UNSENDABLE_MS, makeFixDeliverySweep, type FixDeliverySweepDeps } from './fixDeliverySweep.js';
import { makeHarness, type Harness } from '../../store/fixtures/fixDeliveryHarness.js';

/** The async-capable sweep (D556): a remote inbox answer may be a promise; the step chain and the error path. */
describe('fixDeliverySweep (async steps, D556)', () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => h.store.close());

  const sweepWith = (over: Partial<FixDeliverySweepDeps>) => makeFixDeliverySweep({ ...h.host, projectId: () => h.projectId, ...over });
  /** A typed-route row that nothing sent yet (the agent was running at delivery). */
  const unsent = (ticketId = h.ticketId): number => {
    h.state.route = 'typed';
    h.state.running = true;
    deliverLiveFix(h.host, { ticketId, roundId: null, body: 'B', truncatedFooter: '' });
    h.state.running = false;
    return currentFixDelivery(h.store, ticketId)!.id;
  };
  const lines = (): string[] => vi.mocked(h.host.debug).mock.calls.map((c) => String(c[0]));
  const failures = (): string[] => lines().filter((l) => l.includes('sweep failed'));

  it('an inbox file escalates with its exact text and never asks the host reason', () => {
    const id = unsent();
    h.advance(FIX_POINTER_UNSENDABLE_MS + 1);
    const hostUnsendable = vi.fn(() => 'host reason');
    sweepWith({ unsendableInbox: () => 'inbox/fix-1.md', hostUnsendable }).sweep();
    expect(hostUnsendable).not.toHaveBeenCalled();
    expect(lines()).toContain(`[driver] fix delivery #${id}: pointer unsendable — brief is in inbox/fix-1.md`);
    expect(h.needsYou).toEqual(['the fix pointer could not be sent; the brief is in inbox/fix-1.md — paste a pointer to it']);
  });

  it('a null inbox answer with no host seam is quiet and does not fail the sweep', () => {
    const id = unsent();
    h.advance(FIX_POINTER_UNSENDABLE_MS + 1);
    sweepWith({ unsendableInbox: () => null }).sweep();
    expect(getFixDelivery(h.store, id)!.pointerFailedAt).toBeNull();
    expect(failures()).toEqual([]);
  });

  it('an async inbox answer escalates with the resolved file name', async () => {
    unsent();
    h.advance(FIX_POINTER_UNSENDABLE_MS + 1);
    await sweepWith({ unsendableInbox: async () => 'inbox/fix-2.md' }).sweep();
    expect(h.needsYou).toEqual(['the fix pointer could not be sent; the brief is in inbox/fix-2.md — paste a pointer to it']);
  });

  it('an async null inbox answer continues the chain: the typed pointer is sent, with no failure', async () => {
    unsent();
    h.advance(FIX_POINTER_UNSENDABLE_MS + 1);
    await sweepWith({ unsendableInbox: async () => null }).sweep();
    expect(h.sent).toHaveLength(1);
    expect(h.needsYou).toEqual([]);
    expect(failures()).toEqual([]);
  });

  it('a plain sync tick logs no failure', () => {
    unsent();
    sweepWith({}).sweep();
    expect(h.sent).toHaveLength(1);
    expect(failures()).toEqual([]);
  });

  it('closes a stale conflict row before any rule', () => {
    const id = upsertFixDelivery(h.store, { ticketId: h.ticketId, recoveryRoundId: null, launchId: 'L1', body: 'C', at: h.host.now(), kind: 'conflict', repo: 'api' });
    setMergeCheck(h.store, { ticketId: h.ticketId, repo: 'api', state: 'clean', files: [], reason: null, headSha: 'h', baseSha: 'b', baseRef: 'main', checkedAt: 'x' });
    sweepWith({}).sweep();
    expect(getFixDelivery(h.store, id)!.supersededAt).not.toBeNull();
  });

  it('a rejected async step is logged with its exact text and the next row still runs', async () => {
    const other = createTicket(h.store, { key: 'K-2', title: 't', projectId: h.projectId }).id;
    setStageCurrent(h.store, other, 'fix');
    const first = unsent();
    const second = unsent(other);
    h.advance(FIX_POINTER_UNSENDABLE_MS + 1);
    await sweepWith({ unsendableInbox: () => Promise.reject(new Error('mirror down')) }).sweep();
    expect(failures()).toEqual([
      `[driver] fix delivery #${first}: sweep failed (mirror down)`,
      `[driver] fix delivery #${second}: sweep failed (mirror down)`,
    ]);
  });
});
