import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from './db.js';
import { createTicket } from './tickets.js';
import {
  MAX_FIX_BODY,
  capFixBody,
  claimArmed,
  claimEnqueued,
  claimPointed,
  claimPointerFailed,
  claimRead,
  claimRepointed,
  clearEnqueued,
  currentFixDelivery,
  getFixDelivery,
  markSeedRead,
  rearmFixDelivery,
  supersedeFixDeliveries,
  supersedeFixDelivery,
  upsertFixDelivery,
} from './fixDeliveries.js';

const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-01-01T00:01:00.000Z';

describe('fixDeliveries', () => {
  let store: Store;
  let ticketId: number;
  let otherId: number;
  beforeEach(() => {
    store = openStore(':memory:');
    ticketId = createTicket(store, { key: 'K-1', title: 't' }).id;
    otherId = createTicket(store, { key: 'K-2', title: 'u' }).id;
  });
  afterEach(() => store.close());

  const upsert = (over: Partial<Parameters<typeof upsertFixDelivery>[1]> = {}) =>
    upsertFixDelivery(store, {
      ticketId,
      recoveryRoundId: null,
      launchId: 'L1',
      body: 'brief',
      at: T0,
      ...over,
    });

  it('inserts an untracked row and exposes it as current', () => {
    const id = upsert();
    const row = currentFixDelivery(store, ticketId)!;
    expect(row.id).toBe(id);
    expect(row).toMatchObject({
      ticketId,
      recoveryRoundId: null,
      launchId: 'L1',
      body: 'brief',
      truncated: false,
      createdAt: T0,
      armedAt: null,
      readAt: null,
      deliveredVia: null,
      supersededAt: null,
    });
  });

  it('stores a null launch id as NULL', () => {
    upsert({ launchId: null });
    expect(currentFixDelivery(store, ticketId)!.launchId).toBeNull();
  });

  it('a newer row supersedes the unread older ones of the SAME ticket only', () => {
    const a = upsert();
    const other = upsert({ ticketId: otherId });
    const b = upsert({ at: T1 });
    expect(getFixDelivery(store, a)!.supersededAt).toBe(T1);
    expect(getFixDelivery(store, other)!.supersededAt).toBeNull();
    expect(currentFixDelivery(store, ticketId)!.id).toBe(b);
  });

  it('keeps a READ older row un-superseded', () => {
    const a = upsert();
    claimRead(store, a, 'pointer', T0);
    upsert({ at: T1 });
    expect(getFixDelivery(store, a)!.supersededAt).toBeNull();
  });

  it('re-upserting a tracked round resets the whole delivery on the same row', () => {
    const roundId = 7;
    store.db.pragma('foreign_keys = OFF');
    const a = upsert({ recoveryRoundId: roundId });
    claimArmed(store, a, T0);
    claimPointed(store, a, T0);
    claimRepointed(store, a, T0);
    claimPointerFailed(store, a, T0);
    claimEnqueued(store, a, T0);
    claimRead(store, a, 'pointer', T0);
    supersedeFixDelivery(store, a, T0);
    const again = upsert({ recoveryRoundId: roundId, launchId: 'L2', body: 'new', at: T1 });
    expect(again).toBe(a);
    expect(getFixDelivery(store, a)).toMatchObject({
      launchId: 'L2',
      body: 'new',
      armedAt: null,
      enqueuedAt: null,
      pointedAt: null,
      repointedAt: null,
      pointerFailedAt: null,
      readAt: null,
      deliveredVia: null,
      supersededAt: null,
    });
    expect(currentFixDelivery(store, ticketId)!.id).toBe(a);
  });

  it('a new tracked round inserts a new row (distinct ids) and supersedes the old', () => {
    store.db.pragma('foreign_keys = OFF');
    const a = upsert({ recoveryRoundId: 1 });
    const b = upsert({ recoveryRoundId: 2, at: T1 });
    expect(b).not.toBe(a);
    expect(getFixDelivery(store, a)!.supersededAt).toBe(T1);
  });

  it('rolls back the whole upsert when the insert fails', () => {
    const a = upsert();
    expect(() => upsert({ ticketId: 99999 })).toThrow();
    expect(getFixDelivery(store, a)!.supersededAt).toBeNull();
  });

  it('currentFixDelivery ignores superseded rows and returns null when none', () => {
    expect(currentFixDelivery(store, ticketId)).toBeNull();
    const a = upsert();
    supersedeFixDelivery(store, a, T1);
    expect(currentFixDelivery(store, ticketId)).toBeNull();
  });

  it('supersedeFixDeliveries stamps the unread rows of the ticket, not read or other tickets', () => {
    const a = upsert();
    const other = upsert({ ticketId: otherId });
    expect(supersedeFixDeliveries(store, ticketId, T1)).toBe(1);
    expect(getFixDelivery(store, a)!.supersededAt).toBe(T1);
    expect(getFixDelivery(store, other)!.supersededAt).toBeNull();
    const read = upsert({ at: T0 });
    claimRead(store, read, 'seed', T0);
    expect(supersedeFixDeliveries(store, ticketId, T1)).toBe(0);
    expect(getFixDelivery(store, read)!.supersededAt).toBeNull();
  });

  it('every claim is a conditional once-only transition', () => {
    const id = upsert();
    for (const claim of [claimArmed, claimEnqueued, claimPointed, claimRepointed, claimPointerFailed]) {
      expect(claim(store, id, T0)).toBe(true);
      expect(claim(store, id, T1)).toBe(false);
    }
    const row = getFixDelivery(store, id)!;
    expect(row).toMatchObject({
      armedAt: T0,
      enqueuedAt: T0,
      pointedAt: T0,
      repointedAt: T0,
      pointerFailedAt: T0,
    });
  });

  it('claimRead sets via and refuses a second claim', () => {
    const id = upsert();
    expect(claimRead(store, id, 'pointer', T0)).toBe(true);
    expect(claimRead(store, id, 'seed', T1)).toBe(false);
    expect(getFixDelivery(store, id)).toMatchObject({ readAt: T0, deliveredVia: 'pointer' });
  });

  it('clearEnqueued only clears a set claim', () => {
    const id = upsert();
    expect(clearEnqueued(store, id)).toBe(false);
    claimEnqueued(store, id, T0);
    expect(clearEnqueued(store, id)).toBe(true);
    expect(getFixDelivery(store, id)!.enqueuedAt).toBeNull();
  });

  it('markSeedRead claims the unread row of that launch only', () => {
    const a = upsert({ launchId: 'LA' });
    const b = upsert({ ticketId: otherId, launchId: 'LB' });
    expect(markSeedRead(store, 'LA', T1)).toBe(true);
    expect(markSeedRead(store, 'LA', T1)).toBe(false);
    expect(markSeedRead(store, 'nope', T1)).toBe(false);
    expect(getFixDelivery(store, a)).toMatchObject({ readAt: T1, deliveredVia: 'seed' });
    expect(getFixDelivery(store, b)!.readAt).toBeNull();
  });

  describe('rearmFixDelivery', () => {
    it('swaps the launch id with a fresh clock when the old id still matches', () => {
      const id = upsert({ launchId: 'L1' });
      claimArmed(store, id, T0);
      claimPointed(store, id, T0);
      expect(rearmFixDelivery(store, id, { from: 'L1', to: 'L2', armed: true, at: T1 })).toBe(true);
      expect(getFixDelivery(store, id)).toMatchObject({
        launchId: 'L2',
        armedAt: T1,
        pointedAt: null,
        repointedAt: null,
        pointerFailedAt: null,
      });
    });

    it('typed route leaves armed_at NULL', () => {
      const id = upsert({ launchId: 'L1' });
      expect(rearmFixDelivery(store, id, { from: 'L1', to: 'L2', armed: false, at: T1 })).toBe(true);
      expect(getFixDelivery(store, id)!.armedAt).toBeNull();
    });

    it('is a no-op after another window already re-armed, or once read', () => {
      const id = upsert({ launchId: 'L1' });
      expect(rearmFixDelivery(store, id, { from: 'Lx', to: 'L2', armed: true, at: T1 })).toBe(false);
      claimRead(store, id, 'pointer', T0);
      expect(rearmFixDelivery(store, id, { from: 'L1', to: 'L2', armed: true, at: T1 })).toBe(false);
    });

    it('matches a NULL launch id', () => {
      const id = upsert({ launchId: null });
      expect(rearmFixDelivery(store, id, { from: null, to: 'L2', armed: true, at: T1 })).toBe(true);
      expect(getFixDelivery(store, id)!.launchId).toBe('L2');
    });
  });

  describe('capFixBody', () => {
    it('passes a small body through', () => {
      expect(capFixBody('abc', 'FOOT')).toEqual({ body: 'abc', truncated: false });
    });
    it('truncates over the cap and appends the footer', () => {
      const out = capFixBody('x'.repeat(MAX_FIX_BODY + 10), 'FOOT');
      expect(out.truncated).toBe(true);
      expect(out.body.endsWith('FOOT')).toBe(true);
      expect(out.body.length).toBeLessThanOrEqual(MAX_FIX_BODY);
    });
    it('upsert persists the truncated flag', () => {
      const id = upsert({ body: 'x'.repeat(MAX_FIX_BODY + 1), truncatedFooter: 'FOOT' });
      expect(getFixDelivery(store, id)).toMatchObject({ truncated: true });
    });
  });
});
